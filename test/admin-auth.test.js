// Pruebas de autenticación/autorización del panel de BarberElite.
// Ejecutar: npm test   (sin red, sin base de datos real y sin credenciales reales)
//
// La base de datos apunta a un puerto cerrado: los endpoints que la usan devuelven 500,
// lo que basta para demostrar que la petición NO fue bloqueada por la capa de auth.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'contraseña-de-prueba-larga-123';

let server;
let base;
let auth;

before(async () => {
  // cwd temporal para que dotenv NO cargue un .env real del proyecto.
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'barberelite-test-')));
  process.env.BARBERELITE_DISABLE_SIDE_EFFECTS = '1';
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba-solo-para-tests-0123456789abcdef';
  process.env.ADMIN_SESSION_TTL_MINUTES = '60';
  process.env.ENABLE_WA = 'false';
  delete process.env.ADMIN_PASS;
  delete process.env.TELEGRAM_BOT_TOKEN;

  auth = require(path.join(ROOT, 'security', 'admin-auth.js'));
  process.env.ADMIN_PASS_HASH = auth.hashPassword(PASSWORD);

  const app = require(path.join(ROOT, 'server.js'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const req = (method, url, { token, body } = {}) =>
  fetch(base + url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

async function login(password = PASSWORD) {
  auth.resetLoginState();
  const res = await req('POST', '/api/login', { body: { password } });
  return { res, data: await res.json() };
}

const ADMIN_ENDPOINTS = [
  ['GET', '/api/clientes'],
  ['GET', '/api/crm'],
  ['GET', '/api/export/citas'],
  ['GET', '/api/negocios'],
  ['PATCH', '/api/citas/1/estado'],
  ['DELETE', '/api/citas/1'],
  ['POST', '/api/citas/1/comprobante'],
  ['POST', '/api/categorias'],
  ['PATCH', '/api/categorias/1'],
  ['DELETE', '/api/categorias/1'],
  ['POST', '/api/servicios'],
  ['DELETE', '/api/servicios/1'],
  ['POST', '/api/empleados'],
  ['DELETE', '/api/empleados/1'],
  ['GET', '/api/empleados/1/horarios'],
  ['PUT', '/api/empleados/1/horarios'],
  ['GET', '/api/empleados/1/dias-bloqueados'],
  ['POST', '/api/empleados/1/dias-bloqueados'],
  ['POST', '/api/bloquear-dia'],
  ['DELETE', '/api/bloquear-dia/2026-12-01'],
  ['GET', '/api/whatsapp/status'],
  ['GET', '/api/whatsapp/qr'],
  ['GET', '/api/whatsapp/qr-image'],
  ['GET', '/whatsapp/qr'],
  ['GET', '/whatsapp/qr-image'],
  ['GET', '/api/admin/health'],
  ['GET', '/admin/health'],
  ['POST', '/api/admin/whatsapp/reconnect'],
  ['POST', '/api/admin/recordatorios/reenviar'],
  ['POST', '/api/admin/horarios/reset'],
  ['POST', '/api/admin/whatsapp/test'],
  // Variantes que intentan esquivar la política
  ['GET', '/API/CLIENTES'],
  ['GET', '/api/clientes/'],
  ['GET', '/Api/Export/Citas'],
];

test('sin sesión: todos los endpoints administrativos responden 401', async () => {
  for (const [method, url] of ADMIN_ENDPOINTS) {
    const res = await req(method, url, { body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${url} debería exigir sesión (dio ${res.status})`);
  }
});

test('contraseña incorrecta: 401 y ningún token', async () => {
  const { res, data } = await login('incorrecta');
  assert.equal(res.status, 401);
  assert.equal(data.token, undefined);
});

test('límite de intentos: tras 5 fallos responde 429 incluso con la contraseña correcta', async () => {
  auth.resetLoginState();
  for (let i = 0; i < auth.LOGIN_MAX_FAILURES; i++) {
    const r = await req('POST', '/api/login', { body: { password: `mal-${i}` } });
    assert.equal(r.status, 401);
  }
  const blocked = await req('POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
  auth.resetLoginState();
});

test('contraseña correcta: emite token con expiración y da acceso al panel', async () => {
  const { res, data } = await login();
  assert.equal(res.status, 200);
  assert.equal(typeof data.token, 'string');
  assert.ok(data.expiresAt > Date.now());
  // Endpoint de admin que no necesita BD: debe responder 200 con sesión.
  const status = await req('GET', '/api/whatsapp/status', { token: data.token });
  assert.equal(status.status, 200);
  // Endpoints de admin con BD: no bloqueados por auth (500 = BD de prueba inaccesible).
  for (const url of ['/api/clientes', '/api/crm', '/api/export/citas']) {
    const r = await req('GET', url, { token: data.token });
    assert.notEqual(r.status, 401, `${url} con sesión no debe dar 401`);
  }
});

test('sesión expirada: no permite acceso', async () => {
  const { token } = auth.issueToken(process.env, Date.now() - 2 * 60 * 60 * 1000); // TTL 60 min → vencido
  const res = await req('GET', '/api/whatsapp/status', { token });
  assert.equal(res.status, 401);
});

test('token manipulado o firmado con otro secreto: rechazado', async () => {
  const { data } = await login();
  const [body, sig] = data.token.split('.');
  const tampered = `${body.slice(0, -2)}xx.${sig}`;
  assert.equal((await req('GET', '/api/whatsapp/status', { token: tampered })).status, 401);
  const otherSecret = auth.issueToken({ ...process.env, ADMIN_SESSION_SECRET: 'otro-secreto-distinto-de-al-menos-32-caracteres!!' });
  assert.equal((await req('GET', '/api/whatsapp/status', { token: otherSecret.token })).status, 401);
});

test('logout revoca el token', async () => {
  const { data } = await login();
  assert.equal((await req('GET', '/api/whatsapp/status', { token: data.token })).status, 200);
  assert.equal((await req('POST', '/api/logout', { token: data.token })).status, 200);
  assert.equal((await req('GET', '/api/whatsapp/status', { token: data.token })).status, 401);
});

test('rutas públicas siguen funcionando sin sesión', async () => {
  assert.equal((await req('GET', '/health')).status, 200);
  for (const url of [
    '/api/categorias', '/api/servicios', '/api/empleados',
    '/api/disponibilidad?fecha=2026-12-01', '/api/dias-bloqueados', '/api/citas',
  ]) {
    const r = await req('GET', url);
    assert.notEqual(r.status, 401, `${url} debe ser pública`);
  }
  // POST /api/citas es público: con datos incompletos responde 400 (validación), no 401.
  assert.equal((await req('POST', '/api/citas', { body: {} })).status, 400);
  // El portal (SPA) se sirve sin sesión.
  assert.equal((await req('GET', '/')).status, 200);
});

test('sin ADMIN_SESSION_SECRET el login queda desactivado (fail-closed)', async () => {
  const saved = process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_SESSION_SECRET;
  try {
    auth.resetLoginState();
    const res = await req('POST', '/api/login', { body: { password: PASSWORD } });
    assert.equal(res.status, 503);
    assert.equal((await req('GET', '/api/clientes')).status, 401);
  } finally {
    process.env.ADMIN_SESSION_SECRET = saved;
  }
});

test('vistas públicas no contienen datos personales', () => {
  const { toPublicCita, toPublicEmpleado } = require(path.join(ROOT, 'security', 'public-views.js'));
  const cita = toPublicCita({
    id: 9, nombre: 'Ana', telefono: '2410000000', email: 'a@b.c', comentarios: 'x',
    fecha: '2026-12-01', hora: '10:00', estado: 'pendiente', servicio_id: 2, empleado_id: 3,
  });
  assert.deepEqual(Object.keys(cita).sort(), ['empleado_id', 'estado', 'fecha', 'hora', 'servicio_id']);
  const emp = toPublicEmpleado({ id: 1, nombre: 'Luis', telefono: '2410000000', especialidad: 'Corte' });
  assert.equal(emp.telefono, undefined);
  assert.equal(emp.nombre, 'Luis');
});

test('contraseñas: hash scrypt verificable y contraseña legada con comparación segura', () => {
  const env = { ADMIN_PASS_HASH: auth.hashPassword('otra-clave-de-prueba-99') };
  assert.equal(auth.verifyAdminPassword('otra-clave-de-prueba-99', env), true);
  assert.equal(auth.verifyAdminPassword('otra-clave-de-prueba-98', env), false);
  assert.equal(auth.verifyAdminPassword('legado-123', { ADMIN_PASS: 'legado-123' }), true);
  assert.equal(auth.verifyAdminPassword('', { ADMIN_PASS: '' }), false);
  assert.equal(auth.verifyAdminPassword(undefined, env), false);
});

test('.env.example no contiene valores con forma de secreto real', () => {
  const content = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.doesNotMatch(content, /[0-9]{8,10}:[A-Za-z0-9_-]{30,}/, 'token de Telegram');
  assert.doesNotMatch(content, /^ADMIN_PASS=\S+/m, 'ADMIN_PASS con valor');
  assert.doesNotMatch(content, /^ADMIN_SESSION_SECRET=\S+/m, 'secreto de sesión con valor');
  assert.doesNotMatch(content, /^TELEGRAM_CHAT_ID=\S+/m, 'chat id real');
  assert.doesNotMatch(content, /^WHATSAPP_PHONE_ID=\S+/m, 'phone id real');
  assert.match(content, /postgres:\[YOUR-PASSWORD\]@/, 'DATABASE_URL debe ser un placeholder');
});
