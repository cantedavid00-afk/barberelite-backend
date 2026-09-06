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

// ─── TELEGRAM HELPER ───────────────────────────────────────
async function sendTelegram(message, negocioId){
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  let CHATS = process.env.TELEGRAM_CHAT_ID;
  // Si el negocio tiene chat propio, usar ese
  if(negocioId){
    try{ const n = await getNegocioById(negocioId); if(n && n.telegram_chat_id) CHATS = n.telegram_chat_id; }catch(_){}
  }
  if (!TOKEN || !CHATS) return;
  const chatIds = String(CHATS).split(',').map(id => id.trim()).filter(Boolean);
  for (const chatId of chatIds) {
    try {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error(`Error Telegram a ${chatId}:`, err.message);
    }
  }
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

    const reservadas = await pool.query(
      `SELECT hora FROM citas WHERE fecha = $1 AND negocio_id=$2 AND estado != 'cancelada'`, [fecha, negocioId]
    );
    const horasOcupadas = reservadas.rows.map(r => r.hora);

    const { rows: horarios } = await pool.query(
      `SELECT hora FROM horarios_trabajo WHERE dia_semana = $1 AND negocio_id=$2 AND activo = true ORDER BY hora`,
      [new Date(fecha + 'T12:00:00').getDay(), negocioId]
    );
    const horas = horarios.map(h => ({ hora: h.hora, disponible: !horasOcupadas.includes(h.hora) }));
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
    const ocupado = await pool.query(
      `SELECT id FROM citas WHERE fecha = $1 AND hora = $2 AND negocio_id=$3 AND estado != 'cancelada'`,
      [fecha, hora, negocioId]
    );
    if (ocupado.rows.length > 0) return res.status(409).json({ error: 'Este horario ya fue reservado. Elige otro.' });

    const { rows: [servicio] } = await pool.query(
      'SELECT * FROM servicios WHERE id = $1 AND negocio_id=$2', [servicio_id, negocioId]
    );
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado para este negocio' });

    const { rows: [cita] } = await pool.query(
      `INSERT INTO citas (nombre, telefono, email, servicio_id, fecha, hora, comentarios, estado, negocio_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente', $8) RETURNING *`,
      [nombre, telefono, email, servicio_id, fecha, hora, comentarios || '', negocioId]
    );

    if (notificar !== false) {
      const fechaLegible = new Date(fecha + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
      const negocio = await getNegocioById(negocioId);
      const msg = `✂️ <b>¡Nueva Cita! [${negocio.slug}]</b>\n\n` +
        `👤 <b>Cliente:</b> ${nombre}\n` +
        `📱 <b>Tel:</b> ${telefono}\n` +
        `💈 <b>Servicio:</b> ${servicio.nombre} ($${servicio.precio} MXN)\n` +
        `📅 <b>Fecha:</b> ${fechaLegible}\n` +
        `🕐 <b>Hora:</b> ${hora}\n` +
        (comentarios ? `📝 <b>Nota:</b> ${comentarios}` : '');
      await sendTelegram(msg, negocioId);
    }
    res.status(201).json({ ok: true, cita });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/citas', async (req, res) => {
  const { fecha, estado } = req.query;
  try {
    const negocioId = await getNegocioId(req);
    let q = `SELECT c.*, s.nombre AS servicio_nombre, s.precio FROM citas c JOIN servicios s ON c.servicio_id = s.id WHERE c.negocio_id=$1`;
    const vals = [negocioId];
    if (fecha) { vals.push(fecha); q += ` AND c.fecha = $${vals.length}`; }
    if (estado) { vals.push(estado); q += ` AND c.estado = $${vals.length}`; }
    q += ' ORDER BY c.fecha, c.hora';
    const { rows } = await pool.query(q, vals);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const { rows } = await pool.query(
      `SELECT telefono, nombre, email, COUNT(*) AS total_citas, MAX(fecha) AS ultima_visita, STRING_AGG(comentarios, ' | ') AS historial
       FROM citas WHERE negocio_id=$1 AND estado != 'cancelada' GROUP BY telefono, nombre, email ORDER BY total_citas DESC`, [negocioId]
    );
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
//  CRON JOB — Recordatorio 1 hora antes
// ════════════════════════════════════════
cron.schedule('*/5 * * * *', async () => {
  try {
    const { rows: citas } = await pool.query(
      `SELECT c.*, s.nombre AS servicio_nombre, c.negocio_id FROM citas c JOIN servicios s ON c.servicio_id = s.id
       WHERE c.estado = 'confirmada' AND c.recordatorio_enviado = false
         AND (c.fecha || ' ' || c.hora)::timestamp BETWEEN NOW() + INTERVAL '55 minutes' AND NOW() + INTERVAL '65 minutes'`
    );
    for (const cita of citas) {
      const fechaLeg = new Date(cita.fecha + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
      const msg = `⏰ <b>Recordatorio — En 1 hora</b>\n\n` +
        `👤 ${cita.nombre}\n📱 ${cita.telefono}\n💈 ${cita.servicio_nombre}\n📅 ${fechaLeg} a las ${cita.hora}\n` +
        (cita.comentarios ? `📝 Nota: ${cita.comentarios}` : '');
      await sendTelegram(msg, cita.negocio_id);
      await pool.query('UPDATE citas SET recordatorio_enviado = true WHERE id = $1', [cita.id]);
    }
  } catch (err) { console.error('Error cron recordatorio:', err.message); }
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
