// ═══════════════════════════════════════════════════════════
//  BarberElite - Backend Node.js + Express (Multi-negocio)
//  Incluye: API REST, Cron Jobs, Notificaciones Telegram
//  Soporte ?negocio=slug|id (ej: ?negocio=barberelite o ?negocio=2)
//  Hosting gratis: Render.com
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const cron       = require('node-cron');
const axios      = require('axios');
const path       = require('path');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ─── DB (Supabase PostgreSQL) ──────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── CACHE negocios slug->id ───────────────────────────────
const negocioCache = new Map();
async function getNegocioId(req){
  const raw = req.query.negocio || req.body.negocio || req.params.negocio || 'barberelite';
  if(/^\d+$/.test(String(raw))) return parseInt(raw,10);
  if(negocioCache.has(raw)) return negocioCache.get(raw);
  const { rows } = await pool.query('SELECT id FROM negocios WHERE slug=$1', [raw]);
  if(!rows.length) throw new Error(`Negocio '${raw}' no encontrado`);
  negocioCache.set(raw, rows[0].id);
  return rows[0].id;
}
async function getNegocioById(id){
  const { rows } = await pool.query('SELECT * FROM negocios WHERE id=$1', [id]);
  return rows[0]||null;
}

// ─── HELPERS: WhatsApp y Telegram por negocio ─────────────────
function buildWhatsAppUrl(telefono, mensaje){
  const clean = String(telefono).replace(/\D/g,'');
  const num = clean.startsWith('52') ? clean : `52${clean}`;
  return `https://wa.me/${num}?text=${encodeURIComponent(mensaje)}`;
}
async function sendTelegram(message, negocioId){
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  let CHATS = process.env.TELEGRAM_CHAT_ID;
  if(negocioId){
    try{ const n = await getNegocioById(negocioId); if(n && n.telegram_chat_id) CHATS = n.telegram_chat_id; }catch(_){}
  }
  if (!TOKEN || !CHATS) return false;
  const chatIds = String(CHATS).split(',').map(id => id.trim()).filter(Boolean);
  let ok=false;
  for (const chatId of chatIds) {
    try {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: chatId, text: message, parse_mode: 'HTML' });
      ok=true;
    } catch (err) { console.error(`Error Telegram a ${chatId}:`, err.message); }
  }
  return ok;
}
function plantillaNuevaCita(negocio, servicio, datos){
  const icon = negocio.slug==='club-hipico' ? '🐴' : '✂️';
  return `${icon} <b>¡Nueva Cita! [${negocio.slug}]</b>\n\n` +
    `👤 <b>Cliente:</b> ${datos.nombre}\n📱 <b>Tel:</b> ${datos.telefono}\n` +
    `💈 <b>Servicio:</b> ${servicio.nombre} ($${servicio.precio} MXN)\n` +
    `📅 <b>Fecha:</b> ${datos.fechaLegible}\n🕐 <b>Hora:</b> ${datos.hora}\n` +
    (datos.comentarios ? `📝 <b>Nota:</b> ${datos.comentarios}` : '');
}

// ─── HEALTH CHECK (antes del wildcard) ─────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date() }));

// ─── NEGOCIOS ──────────────────────────────────────────────
app.get('/api/negocios', async (req,res)=>{
  try{ const { rows } = await pool.query('SELECT * FROM negocios WHERE activo=true ORDER BY id'); res.json(rows); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// POST /api/login — Validar contraseña de administrador
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASS) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Contraseña incorrecta' });
  }
});

// ════════════════════════════════════════
//  ENDPOINTS — SERVICIOS
// ════════════════════════════════════════
app.get('/api/servicios', async (req, res) => {
  try {
    const negocioId = await getNegocioId(req);
    const { rows } = await pool.query(
      'SELECT * FROM servicios WHERE activo = true AND negocio_id=$1 ORDER BY id', [negocioId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
//  ENDPOINTS — DISPONIBILIDAD
// ════════════════════════════════════════
app.get('/api/disponibilidad', async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
  try {
    const negocioId = await getNegocioId(req);
    const bloqueado = await pool.query(
      'SELECT id FROM dias_bloqueados WHERE fecha = $1 AND negocio_id=$2', [fecha, negocioId]
    );
    if (bloqueado.rows.length > 0) return res.json({ disponible: false, horas: [] });

    // Citas del día con duración exacta del servicio
    const { rows: reservadas } = await pool.query(
      `SELECT c.hora, s.duracion FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.fecha=$1 AND c.negocio_id=$2 AND c.estado!='cancelada'`, [fecha, negocioId]
    );
    const toMin = t => { const [h,m]=String(t).split(':').map(Number); return h*60+m; };
    const { rows: horarios } = await pool.query(
      `SELECT hora FROM horarios_trabajo WHERE dia_semana=$1 AND negocio_id=$2 AND activo=true ORDER BY hora`,
      [new Date(fecha + 'T12:00:00').getDay(), negocioId]
    );
    const horas = horarios.map(h => {
      const sm = toMin(h.hora);
      const ocupado = reservadas.some(r => { const s=toMin(r.hora), e=s+(r.duracion||30); return sm>=s && sm<e; });
      return { hora: h.hora, disponible: !ocupado };
    });
    res.json({ disponible: true, horas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
//  ENDPOINTS — CITAS
// ════════════════════════════════════════
app.post('/api/citas', async (req, res) => {
  const { nombre, telefono, email, servicio_id, fecha, hora, comentarios, notificar } = req.body;
  if (!nombre || !telefono || !servicio_id || !fecha || !hora) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  try {
    const negocioId = await getNegocioId(req);
    const { rows: [servicio] } = await pool.query(
      'SELECT * FROM servicios WHERE id = $1 AND negocio_id=$2', [servicio_id, negocioId]
    );
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado para este negocio' });
    // Validación solape con duración exacta
    const toMin = t => { const [h,m]=String(t).split(':').map(Number); return h*60+m; };
    const ns = toMin(hora), ne = ns + (servicio.duracion||30);
    const { rows: existentes } = await pool.query(
      `SELECT c.hora, s.duracion FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.fecha=$1 AND c.negocio_id=$2 AND c.estado!='cancelada'`, [fecha, negocioId]
    );
    const solapa = existentes.some(r=>{ const s=toMin(r.hora), e=s+(r.duracion||30); return ns<e && ne>s; });
    if(solapa) return res.status(409).json({ error: 'Este horario se solapa con otra cita (duración exacta). Elige otro.' });

    const { rows: [cita] } = await pool.query(
      `INSERT INTO citas (nombre, telefono, email, servicio_id, fecha, hora, comentarios, estado, negocio_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente', $8) RETURNING *`,
      [nombre, telefono, email, servicio_id, fecha, hora, comentarios || '', negocioId]
    );

    let telegramOk=false;
    if (notificar !== false) {
      const fechaLegible = new Date(fecha + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
      const negocio = await getNegocioById(negocioId);
      const msg = plantillaNuevaCita(negocio, servicio, { nombre, telefono, fechaLegible, hora, comentarios });
      telegramOk = await sendTelegram(msg, negocioId);
    }
    const waMsg = `Hola ${nombre}, tu cita de ${servicio.nombre} el ${fecha} a las ${hora} está confirmada. ¡Te esperamos!`;
    const whatsappUrl = buildWhatsAppUrl(telefono, waMsg);
    res.status(201).json({ ok: true, cita, whatsappUrl, telegramOk });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/citas', async (req, res) => {
  const { fecha, estado, q: search, limit, offset } = req.query;
  try {
    const negocioId = await getNegocioId(req);
    let q = `SELECT c.*, s.nombre AS servicio_nombre, s.precio FROM citas c JOIN servicios s ON c.servicio_id = s.id WHERE c.negocio_id=$1`;
    const vals = [negocioId];
    if (fecha) { vals.push(fecha); q += ` AND c.fecha = $${vals.length}`; }
    if (estado) { vals.push(estado); q += ` AND c.estado = $${vals.length}`; }
    if (search) { vals.push(`%${search}%`); q += ` AND (c.nombre ILIKE $${vals.length} OR c.telefono ILIKE $${vals.length})`; }
    q += ' ORDER BY c.fecha, c.hora';
    if(limit){ vals.push(parseInt(limit)); q+=` LIMIT $${vals.length}`; if(offset){ vals.push(parseInt(offset)); q+=` OFFSET $${vals.length}`; } }
    const { rows } = await pool.query(q, vals);
    // total para paginación
    if(limit){
      const cnt = await pool.query(`SELECT COUNT(*) FROM citas c WHERE c.negocio_id=$1`, [negocioId]);
      res.json({ rows, total: parseInt(cnt.rows[0].count) });
    } else res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/export/citas', async (req,res)=>{
  try{
    const negocioId = await getNegocioId(req);
    const { rows } = await pool.query(`SELECT c.nombre, c.telefono, c.email, s.nombre as servicio, c.fecha, c.hora, c.estado FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.negocio_id=$1 ORDER BY c.fecha`, [negocioId]);
    let csv='Nombre,Telefono,Email,Servicio,Fecha,Hora,Estado\n';
    rows.forEach(r=> csv+=`"${r.nombre}","${r.telefono}","${r.email||''}","${r.servicio}","${r.fecha.toISOString().split('T')[0]}","${r.hora}","${r.estado}"\n`);
    res.header('Content-Type','text/csv'); res.attachment(`citas-${negocioId}.csv`); res.send(csv);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/citas/:id/estado', async (req, res) => {
  const { estado } = req.body;
  try {
    const negocioId = await getNegocioId(req);
    const { rows: [cita] } = await pool.query(
      `UPDATE citas SET estado = $1, updated_at = NOW() WHERE id = $2 AND negocio_id=$3 RETURNING *`,
      [estado, req.params.id, negocioId]
    );
    if(!cita) return res.status(404).json({error:'Cita no encontrada para este negocio'});
    res.json(cita);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/citas/:id', async (req, res) => {
  try {
    const negocioId = await getNegocioId(req);
    await pool.query('DELETE FROM citas WHERE id = $1 AND negocio_id=$2', [req.params.id, negocioId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
//  ENDPOINTS — ADMIN DISPONIBILIDAD
// ════════════════════════════════════════
app.get('/api/dias-bloqueados', async (req, res) => {
  try {
    const negocioId = await getNegocioId(req);
    const { rows } = await pool.query('SELECT fecha FROM dias_bloqueados WHERE negocio_id=$1', [negocioId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bloquear-dia', async (req, res) => {
  const { fecha, motivo } = req.body;
  try {
    const negocioId = await getNegocioId(req);
    await pool.query(
      'INSERT INTO dias_bloqueados (fecha, motivo, negocio_id) VALUES ($1, $2, $3) ON CONFLICT (fecha) DO UPDATE SET motivo=EXCLUDED.motivo, negocio_id=EXCLUDED.negocio_id',
      [fecha, motivo || '', negocioId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bloquear-dia/:fecha', async (req, res) => {
  try {
    const negocioId = await getNegocioId(req);
    await pool.query('DELETE FROM dias_bloqueados WHERE fecha = $1 AND negocio_id=$2', [req.params.fecha, negocioId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
//  ENDPOINTS — CLIENTES (CRM)
// ════════════════════════════════════════
app.get('/api/clientes', async (req, res) => {
  try {
    const negocioId = await getNegocioId(req);
    const { q } = req.query;
    let sql = `SELECT telefono, nombre, email, COUNT(*) AS total_citas, MAX(fecha) AS ultima_visita, STRING_AGG(comentarios, ' | ') AS historial
       FROM citas WHERE negocio_id=$1 AND estado != 'cancelada'`;
    const vals=[negocioId];
    if(q){ vals.push(`%${q}%`); sql+=` AND (nombre ILIKE $${vals.length} OR telefono ILIKE $${vals.length})`; }
    sql+=` GROUP BY telefono, nombre, email ORDER BY total_citas DESC`;
    const { rows } = await pool.query(sql, vals);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Vista CRM agregada
app.get('/api/crm', async (req,res)=>{
  try{
    const negocioId = await getNegocioId(req);
    const { rows } = await pool.query('SELECT * FROM vista_clientes WHERE negocio_id=$1', [negocioId]);
    res.json(rows);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════
//  CRON JOBS — Recordatorios 24h y 1h antes
// ════════════════════════════════════════
cron.schedule('*/5 * * * *', async () => {
  // Recordatorio 1 hora antes (55-65 min)
  try {
    const { rows: citas } = await pool.query(
      `SELECT c.*, s.nombre AS servicio_nombre, c.negocio_id FROM citas c JOIN servicios s ON c.servicio_id = s.id
       WHERE c.estado = 'confirmada' AND c.recordatorio_enviado = false
         AND (c.fecha || ' ' || c.hora)::timestamp BETWEEN NOW() + INTERVAL '55 minutes' AND NOW() + INTERVAL '65 minutes'`
    );
    for (const cita of citas) {
      const fechaLeg = new Date(cita.fecha + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
      const icon = cita.negocio_id===2 ? '🐴' : '✂️';
      const msg = `⏰ <b>Recordatorio — En 1 hora ${icon}</b>\n\n` +
        `👤 ${cita.nombre}\n📱 ${cita.telefono}\n💈 ${cita.servicio_nombre}\n📅 ${fechaLeg} a las ${cita.hora}\n` +
        (cita.comentarios ? `📝 Nota: ${cita.comentarios}` : '');
      await sendTelegram(msg, cita.negocio_id);
      await pool.query('UPDATE citas SET recordatorio_enviado = true WHERE id = $1', [cita.id]);
    }
  } catch (err) { console.error('Error cron 1h:', err.message); }
});
// Recordatorio 24h antes (corre cada hora)
cron.schedule('0 * * * *', async () => {
  try {
    const { rows: citas } = await pool.query(
      `SELECT c.*, s.nombre AS servicio_nombre, c.negocio_id, n.slug FROM citas c
       JOIN servicios s ON c.servicio_id=s.id JOIN negocios n ON c.negocio_id=n.id
       WHERE c.estado='confirmada' AND (c.fecha || ' ' || c.hora)::timestamp BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'`
    );
    for(const cita of citas){
      const fechaLeg = new Date(cita.fecha + 'T12:00:00').toLocaleDateString('es-MX', {weekday:'long', day:'numeric', month:'long'});
      const msg = `📅 <b>Recordatorio 24h [${cita.slug}]</b>\n\nHola ${cita.nombre}, te esperamos mañana ${fechaLeg} a las ${cita.hora} para ${cita.servicio_nombre}. ¡No faltes!`;
      await sendTelegram(msg, cita.negocio_id);
    }
  } catch(e){ console.error('Error cron 24h:', e.message); }
});

// ════════════════════════════════════════
//  CONFIGURACIÓN DEL FRONTEND
// ════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✂️  BarberElite API (multi-negocio) corriendo en puerto ${PORT}`));
