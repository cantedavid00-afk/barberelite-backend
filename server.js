// ═══════════════════════════════════════════════════════════
//  BarberElite - Backend Node.js + Express
//  Incluye: API REST, Cron Jobs, Notificaciones Telegram
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
  ssl: { rejectUnauthorized: false }, // necesario en Supabase/Render
});

// ─── TELEGRAM HELPER ───────────────────────────────────────
// ─── TELEGRAM HELPER ACTUALIZADO ───────────────────────────
async function sendTelegram(message) {
  const TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
  const CHATS  = process.env.TELEGRAM_CHAT_ID;
  if (!TOKEN || !CHATS) return;

  // Separamos los IDs por coma y quitamos espacios en blanco por si acaso
  const chatIds = CHATS.split(',').map(id => id.trim());

  // Enviamos el mensaje a cada ID
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

// ════════════════════════════════════════
//  ENDPOINTS — SERVICIOS
// ════════════════════════════════════════

// GET /api/servicios
app.get('/api/servicios', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM servicios WHERE activo = true ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
//  ENDPOINTS — DISPONIBILIDAD
// ════════════════════════════════════════

// GET /api/disponibilidad?fecha=YYYY-MM-DD
app.get('/api/disponibilidad', async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta fecha' });

  try {
    // Verificar si el día está bloqueado
    const bloqueado = await pool.query(
      'SELECT id FROM dias_bloqueados WHERE fecha = $1', [fecha]
    );
    if (bloqueado.rows.length > 0) {
      return res.json({ disponible: false, horas: [] });
    }

    // Obtener horas ya reservadas ese día
    const reservadas = await pool.query(
      `SELECT hora FROM citas
       WHERE fecha = $1 AND estado != 'cancelada'`, [fecha]
    );
    const horasOcupadas = reservadas.rows.map(r => r.hora);

    // Todas las horas de trabajo
    const { rows: horarios } = await pool.query(
      `SELECT hora FROM horarios_trabajo
       WHERE dia_semana = $1 AND activo = true
       ORDER BY hora`,
      [new Date(fecha + 'T12:00:00').getDay()]
    );

    const horas = horarios.map(h => ({
      hora: h.hora,
      disponible: !horasOcupadas.includes(h.hora),
    }));

    res.json({ disponible: true, horas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
//  ENDPOINTS — CITAS
// ════════════════════════════════════════

// POST /api/citas  — Crear nueva cita
app.post('/api/citas', async (req, res) => {
  // Extraemos "notificar" del body para saber si es un bloqueo silencioso del Admin
  const { nombre, telefono, email, servicio_id, fecha, hora, comentarios, notificar } = req.body;

  // Validaciones básicas
  if (!nombre || !telefono || !servicio_id || !fecha || !hora) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  try {
    // Verificar que el slot sigue disponible (race condition)
    const ocupado = await pool.query(
      `SELECT id FROM citas
       WHERE fecha = $1 AND hora = $2 AND estado != 'cancelada'`,
      [fecha, hora]
    );
    if (ocupado.rows.length > 0) {
      return res.status(409).json({ error: 'Este horario ya fue reservado. Elige otro.' });
    }

    // Obtener datos del servicio
    const { rows: [servicio] } = await pool.query(
      'SELECT * FROM servicios WHERE id = $1', [servicio_id]
    );
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });

    // Insertar cita
    const { rows: [cita] } = await pool.query(
      `INSERT INTO citas
         (nombre, telefono, email, servicio_id, fecha, hora, comentarios, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente')
       RETURNING *`,
      [nombre, telefono, email, servicio_id, fecha, hora, comentarios || '']
    );

    // ── NOTIFICACIÓN TELEGRAM AL BARBERO ──────────────────
    // SOLO si notificar no es estrictamente "false" enviamos el mensaje
    if (notificar !== false) {
      const fechaLegible = new Date(fecha + 'T12:00:00').toLocaleDateString('es-MX', {
        weekday: 'long', day: 'numeric', month: 'long',
      });
      const msg = `✂️ <b>¡Nueva Cita!</b>\n\n` +
        `👤 <b>Cliente:</b> ${nombre}\n` +
        `📱 <b>Tel:</b> ${telefono}\n` +
        `💈 <b>Servicio:</b> ${servicio.nombre} ($${servicio.precio} MXN)\n` +
        `📅 <b>Fecha:</b> ${fechaLegible}\n` +
        `🕐 <b>Hora:</b> ${hora}\n` +
        (comentarios ? `📝 <b>Nota:</b> ${comentarios}` : '');
      await sendTelegram(msg);
    }

    res.status(201).json({ ok: true, cita });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/citas?fecha=YYYY-MM-DD
app.get('/api/citas', async (req, res) => {
  const { fecha, estado } = req.query;
  try {
    let q = `SELECT c.*, s.nombre AS servicio_nombre, s.precio
             FROM citas c JOIN servicios s ON c.servicio_id = s.id WHERE 1=1`;
    const vals = [];
    if (fecha) { vals.push(fecha); q += ` AND c.fecha = $${vals.length}`; }
    if (estado) { vals.push(estado); q += ` AND c.estado = $${vals.length}`; }
    q += ' ORDER BY c.fecha, c.hora';
    const { rows } = await pool.query(q, vals);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/citas/:id/estado
app.patch('/api/citas/:id/estado', async (req, res) => {
  const { estado } = req.body; // 'confirmada' | 'cancelada' | 'completada'
  try {
    const { rows: [cita] } = await pool.query(
      `UPDATE citas SET estado = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [estado, req.params.id]
    );
    res.json(cita);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NUEVO: DELETE /api/citas/:id (Permite borrar citas, necesario para los bloqueos)
app.delete('/api/citas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM citas WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ════════════════════════════════════════
//  ENDPOINTS — ADMIN DISPONIBILIDAD
// ════════════════════════════════════════

// NUEVO: GET /api/dias-bloqueados (El frontend lo necesita para pintarlos de rojo)
app.get('/api/dias-bloqueados', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT fecha FROM dias_bloqueados');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bloquear-dia
app.post('/api/bloquear-dia', async (req, res) => {
  const { fecha, motivo } = req.body;
  try {
    await pool.query(
      'INSERT INTO dias_bloqueados (fecha, motivo) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [fecha, motivo || '']
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bloquear-dia/:fecha
app.delete('/api/bloquear-dia/:fecha', async (req, res) => {
  try {
    await pool.query('DELETE FROM dias_bloqueados WHERE fecha = $1', [req.params.fecha]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
//  ENDPOINTS — CLIENTES (CRM)
// ════════════════════════════════════════

// GET /api/clientes
app.get('/api/clientes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT telefono, nombre, email,
              COUNT(*) AS total_citas,
              MAX(fecha) AS ultima_visita,
              STRING_AGG(comentarios, ' | ') AS historial
       FROM citas
       WHERE estado != 'cancelada'
       GROUP BY telefono, nombre, email
       ORDER BY total_citas DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
//  CRON JOB — Recordatorio 1 hora antes
// ════════════════════════════════════════
// Se ejecuta cada 5 minutos para buscar citas que inicien en ~60 min
cron.schedule('*/5 * * * *', async () => {
  try {
    const ahora = new Date();
    // Buscar citas que empiecen entre 55 y 65 minutos en el futuro
    // y que NO hayan recibido recordatorio aún
    const { rows: citas } = await pool.query(
      `SELECT c.*, s.nombre AS servicio_nombre
       FROM citas c
       JOIN servicios s ON c.servicio_id = s.id
       WHERE c.estado = 'confirmada'
         AND c.recordatorio_enviado = false
         AND (c.fecha || ' ' || c.hora)::timestamp
             BETWEEN NOW() + INTERVAL '55 minutes'
             AND     NOW() + INTERVAL '65 minutes'`
    );

    for (const cita of citas) {
      const fechaLeg = new Date(cita.fecha + 'T12:00:00').toLocaleDateString('es-MX', {
        day: 'numeric', month: 'long',
      });
      const msg = `⏰ <b>Recordatorio — En 1 hora</b>\n\n` +
        `👤 ${cita.nombre}\n` +
        `📱 ${cita.telefono}\n` +
        `💈 ${cita.servicio_nombre}\n` +
        `📅 ${fechaLeg} a las ${cita.hora}\n` +
        (cita.comentarios ? `📝 Nota: ${cita.comentarios}` : '');

      await sendTelegram(msg);

      // Marcar como enviado para no duplicar
      await pool.query(
        'UPDATE citas SET recordatorio_enviado = true WHERE id = $1', [cita.id]
      );
    }
  } catch (err) {
    console.error('Error cron recordatorio:', err.message);
  }
});

// ════════════════════════════════════════
//  CONFIGURACIÓN DEL FRONTEND
// ════════════════════════════════════════
// 1. Le decimos a Express que la carpeta "public" contiene los archivos web
app.use(express.static(path.join(__dirname, 'public')));

// 2. Cualquier ruta que no sea de la API, mostrará tu index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════
//  HEALTH CHECK & START
// ════════════════════════════════════════
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✂️  BarberElite API corriendo en puerto ${PORT}`));
