// security/admin-auth.js
//
// Autenticación del panel de administración de BarberElite.
//
// Por qué un token Bearer firmado y no una cookie de sesión: el panel se sirve
// desde un origen (Vercel) y llama a la API en otro (Render). Una cookie entre
// sitios exigiría SameSite=None y los navegadores la bloquean cada vez más; un
// token en la cabecera Authorization funciona entre orígenes y, como el navegador
// no lo envía automáticamente, no es vulnerable a CSRF.
//
// Solo usa módulos nativos de Node (crypto). Sin dependencias nuevas.

const crypto = require('crypto');

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MINUTES = 8 * 60;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 24 * 60;
const MIN_SECRET_LENGTH = 32;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MAX_TRACKED_IPS = 10_000;

// ─── Configuración ─────────────────────────────────────────────────────────

function readConfig(env = process.env) {
  const secret = env.ADMIN_SESSION_SECRET || '';
  const ttlRaw = parseInt(env.ADMIN_SESSION_TTL_MINUTES || '', 10);
  const ttlMinutes = Number.isFinite(ttlRaw)
    ? Math.min(Math.max(ttlRaw, MIN_TTL_MINUTES), MAX_TTL_MINUTES)
    : DEFAULT_TTL_MINUTES;
  return {
    secret,
    secretOk: secret.length >= MIN_SECRET_LENGTH,
    passwordHash: env.ADMIN_PASS_HASH || '',
    legacyPassword: env.ADMIN_PASS || '',
    ttlMs: ttlMinutes * 60 * 1000,
  };
}

/** Advertencias de arranque: solo nombres de variables, nunca valores. */
function configWarnings(env = process.env) {
  const c = readConfig(env);
  const warnings = [];
  if (!c.secretOk) {
    warnings.push(`ADMIN_SESSION_SECRET falta o tiene menos de ${MIN_SECRET_LENGTH} caracteres: el login de administrador queda DESACTIVADO (las rutas públicas siguen funcionando).`);
  }
  if (!c.passwordHash && !c.legacyPassword) {
    warnings.push('No hay ADMIN_PASS_HASH ni ADMIN_PASS: el login de administrador queda DESACTIVADO.');
  } else if (!c.passwordHash) {
    warnings.push('Se está usando ADMIN_PASS en texto plano. Genera ADMIN_PASS_HASH con `npm run hash-admin-password` y elimina ADMIN_PASS.');
  }
  return warnings;
}

// ─── Contraseña ────────────────────────────────────────────────────────────

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Devuelve "scrypt$N$r$p$salt$hash" (base64url). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const hash = crypto.scryptSync(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

function verifyScrypt(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr), r = Number(rStr), p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  if (expected.length < 32) return false;
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N, r, p, maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

function safeEqualStrings(a, b) {
  // Compara digests de longitud fija para no filtrar la longitud ni el contenido por tiempo.
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

function verifyAdminPassword(password, env = process.env) {
  const c = readConfig(env);
  if (typeof password !== 'string' || password.length === 0 || password.length > 512) return false;
  if (c.passwordHash) return verifyScrypt(password, c.passwordHash);
  if (c.legacyPassword) return safeEqualStrings(password, c.legacyPassword);
  return false;
}

// ─── Tokens ────────────────────────────────────────────────────────────────

const revokedTokenIds = new Map(); // jti -> exp (ms). Por instancia; ver riesgos residuales.

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function issueToken(env = process.env, now = Date.now()) {
  const c = readConfig(env);
  if (!c.secretOk) throw new Error('ADMIN_SESSION_SECRET no configurado');
  const payload = {
    v: TOKEN_VERSION,
    sub: 'admin',
    iat: now,
    exp: now + c.ttlMs,
    jti: crypto.randomBytes(16).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(body, c.secret)}`, expiresAt: payload.exp };
}

/** Devuelve el payload si el token es válido y vigente; si no, null. */
function verifyToken(token, env = process.env, now = Date.now()) {
  const c = readConfig(env);
  if (!c.secretOk || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = Buffer.from(sign(body, c.secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.v !== TOKEN_VERSION || payload.sub !== 'admin') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (revokedTokenIds.has(payload.jti)) return null;
  return payload;
}

function revokeToken(payload, now = Date.now()) {
  for (const [jti, exp] of revokedTokenIds) if (exp <= now) revokedTokenIds.delete(jti);
  revokedTokenIds.set(payload.jti, payload.exp);
}

function bearerFrom(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// ─── Límite de intentos de login ───────────────────────────────────────────

const loginFailures = new Map(); // ip -> { count, resetAt }

function loginBlockedFor(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) return 0;
  return entry.count >= LOGIN_MAX_FAILURES ? entry.resetAt - now : 0;
}

function recordLoginFailure(ip, now = Date.now()) {
  if (loginFailures.size >= MAX_TRACKED_IPS) {
    for (const [k, v] of loginFailures) if (v.resetAt <= now) loginFailures.delete(k);
    if (loginFailures.size >= MAX_TRACKED_IPS) loginFailures.clear();
  }
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else entry.count += 1;
}

function resetLoginState() {
  loginFailures.clear();
  revokedTokenIds.clear();
}

// ─── Política de acceso (deny-by-default) ──────────────────────────────────
//
// Todo lo que cuelga de /api/, /admin/ o /whatsapp/ exige sesión de admin,
// salvo esta lista explícita de rutas públicas que usa el portal de clientes.
// Una ruta nueva queda protegida por defecto.

const PUBLIC_ROUTES = [
  ['POST', /^\/api\/login$/],
  ['POST', /^\/api\/logout$/],
  ['GET', /^\/api\/categorias$/],
  ['GET', /^\/api\/servicios$/],
  ['GET', /^\/api\/empleados$/],       // el handler oculta datos de contacto si no es admin
  ['GET', /^\/api\/disponibilidad$/],
  ['GET', /^\/api\/dias-bloqueados$/],
  ['GET', /^\/api\/citas$/],           // el handler devuelve solo ocupación si no es admin
  ['POST', /^\/api\/citas$/],
];
const PROTECTED_PREFIXES = ['/api/', '/admin/', '/whatsapp/'];

function isProtectedPath(path) {
  // Express enruta sin distinguir mayúsculas: normalizamos para que /API/x no esquive la política.
  const p = String(path).toLowerCase();
  return PROTECTED_PREFIXES.some((prefix) => p.startsWith(prefix) || p === prefix.slice(0, -1));
}

function isPublicRoute(method, path) {
  const p = String(path).toLowerCase();
  const m = method === 'HEAD' ? 'GET' : method;
  return PUBLIC_ROUTES.some(([rm, re]) => rm === m && re.test(p));
}

/** Marca req.isAdmin y bloquea rutas protegidas sin sesión válida. */
function adminGuard(req, res, next) {
  const payload = verifyToken(bearerFrom(req));
  req.isAdmin = Boolean(payload);
  req.adminSession = payload || null;
  if (req.method === 'OPTIONS') return next();
  if (!isProtectedPath(req.path) || isPublicRoute(req.method, req.path)) return next();
  if (req.isAdmin) return next();
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: 'No autorizado. Inicia sesión como administrador.' });
}

// ─── Handlers de login/logout ──────────────────────────────────────────────

function loginHandler(req, res) {
  const c = readConfig();
  if (!c.secretOk || (!c.passwordHash && !c.legacyPassword)) {
    return res.status(503).json({ error: 'El acceso de administrador no está configurado en el servidor.' });
  }
  const ip = req.ip || 'unknown';
  const waitMs = loginBlockedFor(ip);
  if (waitMs > 0) {
    res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  }
  const password = req.body && req.body.password;
  if (!verifyAdminPassword(password)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  loginFailures.delete(ip);
  const { token, expiresAt } = issueToken();
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, token, expiresAt });
}

function logoutHandler(req, res) {
  if (req.adminSession) revokeToken(req.adminSession);
  return res.json({ ok: true });
}

module.exports = {
  adminGuard,
  loginHandler,
  logoutHandler,
  configWarnings,
  hashPassword,
  verifyAdminPassword,
  issueToken,
  verifyToken,
  isPublicRoute,
  isProtectedPath,
  resetLoginState,
  LOGIN_MAX_FAILURES,
};
