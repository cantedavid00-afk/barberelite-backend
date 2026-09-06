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
let baileys=null;
try{ baileys=require('./whatsapp'); }catch(e){ console.log('[WA] Baileys no cargado', e.message); }
async function sendWhatsApp(telefono, mensaje){
  // 0) Baileys (prioridad si está conectado) — gratis, sin Meta, a cualquier cliente
  if(baileys){
    try{
      const ok = await baileys.sendViaBaileys(telefono, mensaje);
      if(ok) return true;
    }catch(e){}
  }
  const clean = String(telefono).replace(/\D/g,'');
  const num = clean.startsWith('52') ? clean : `52${clean}`;
  // 1) Meta Cloud API si está configurado
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if(token && phoneId && token!=='demo'){
    try{
      await axios.post(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
        messaging_product:'whatsapp', to: num, type:'text', text:{ body: mensaje }
      }, { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json'} });
      return true;
    }catch(e){ console.error('WA Meta error', e.response?.data||e.message); }
  }
  // 2) CallMeBot gratis (sin Meta) — requiere CALLMEBOT_APIKEY en Render
  const cbKey = process.env.CALLMEBOT_APIKEY;
  if(cbKey && cbKey!=='demo'){
    try{
      const url=`https://api.callmebot.com/whatsapp.php?phone=${num}&text=${encodeURIComponent(mensaje)}&apikey=${cbKey}`;
      const r=await axios.get(url);
      console.log('[WA CallMeBot]', r.data?.toString().slice(0,120));
      return true;
    }catch(e){ console.error('WA CallMeBot error', e.message); }
  }
  // 3) Fallback demo (log) — útil en Render Free si no hay API
  console.log(`[WA demo] Para ${num}: ${mensaje.slice(0,80)}... (configura WHATSAPP_TOKEN o CALLMEBOT_APIKEY en Render para envío real)`);
  return false;
}

// ─── HEALTH CHECK (antes del wildcard) ─────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date() }));

// ─── NEGOCIOS ──────────────────────────────────────────────
app.get('/api/negocios', async (req,res)=>{
  try{ const { rows } = await pool.query('SELECT * FROM negocios WHERE activo=true ORDER BY id'); res.json(rows); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// ─── CATEGORIAS ──────────────────────────────────────────
app.get('/api/categorias', async (req,res)=>{
  try{ const nid=await getNegocioId(req); const {rows}=await pool.query('SELECT * FROM categorias WHERE negocio_id=$1 ORDER BY nombre', [nid]); res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/categorias', async (req,res)=>{
  try{ const nid=await getNegocioId(req); const {nombre, descripcion, color}=req.body; if(!nombre) return res.status(400).json({error:'Nombre requerido'}); const {rows:[c]}=await pool.query('INSERT INTO categorias (negocio_id,nombre,descripcion,color) VALUES ($1,$2,$3,$4) RETURNING *', [nid,nombre,descripcion||'',color||'#FF2D55']); res.status(201).json(c);}catch(e){res.status(500).json({error:e.message});}
});
app.patch('/api/categorias/:id', async (req,res)=>{
  try{ const nid=await getNegocioId(req); const {nombre, descripcion, color, activo}=req.body; const {rows:[c]}=await pool.query('UPDATE categorias SET nombre=COALESCE($1,nombre), descripcion=COALESCE($2,descripcion), color=COALESCE($3,color), activo=COALESCE($4,activo) WHERE id=$5 AND negocio_id=$6 RETURNING *', [nombre,descripcion,color,activo,req.params.id,nid]); res.json(c);}catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/categorias/:id', async (req,res)=>{
  try{ const nid=await getNegocioId(req); await pool.query('DELETE FROM categorias WHERE id=$1 AND negocio_id=$2', [req.params.id,nid]); res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});

// ─── EMPLEADOS ───────────────────────────────────────────
app.get('/api/empleados', async (req,res)=>{
  try{ const nid=await getNegocioId(req); const {rows}=await pool.query(`SELECT e.*, COALESCE(array_agg(c.nombre) FILTER (WHERE c.id IS NOT NULL), '{}') as categorias, COALESCE(array_agg(c.id) FILTER (WHERE c.id IS NOT NULL), '{}') as categoria_ids FROM empleados e LEFT JOIN empleado_categorias ec ON ec.empleado_id=e.id LEFT JOIN categorias c ON c.id=ec.categoria_id WHERE e.negocio_id=$1 GROUP BY e.id ORDER BY e.nombre`, [nid]); res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/empleados', async (req,res)=>{
  try{ const nid=await getNegocioId(req); const {nombre, telefono, especialidad, foto_url, categoria_ids}=req.body; if(!nombre) return res.status(400).json({error:'Nombre requerido'}); const {rows:[emp]}=await pool.query('INSERT INTO empleados (negocio_id,nombre,telefono,especialidad,foto_url) VALUES ($1,$2,$3,$4,$5) RETURNING *', [nid,nombre,telefono||'',especialidad||'',foto_url||'']); if(categoria_ids && categoria_ids.length){ for(const cid of categoria_ids) await pool.query('INSERT INTO empleado_categorias (empleado_id,categoria_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [emp.id, cid]); // clonar horarios globales
      await pool.query('INSERT INTO empleado_horarios (empleado_id,dia_semana,hora) SELECT $1, dia_semana, hora FROM horarios_trabajo WHERE negocio_id=$2 ON CONFLICT DO NOTHING', [emp.id, nid]); } res.status(201).json(emp);}catch(e){res.status(500).json({error:e.message});}
});
app.patch('/api/empleados/:id', async (req,res)=>{
  try{ const nid=await getNegocioId(req); const {nombre, telefono, especialidad, activo, categoria_ids}=req.body; await pool.query('UPDATE empleados SET nombre=COALESCE($1,nombre), telefono=COALESCE($2,telefono), especialidad=COALESCE($3,especialidad), activo=COALESCE($4,activo) WHERE id=$5 AND negocio_id=$6', [nombre,telefono,especialidad,activo,req.params.id,nid]); if(categoria_ids!==undefined){ await pool.query('DELETE FROM empleado_categorias WHERE empleado_id=$1', [req.params.id]); for(const cid of categoria_ids) await pool.query('INSERT INTO empleado_categorias VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id,cid]); } const {rows:[emp]}=await pool.query('SELECT * FROM empleados WHERE id=$1', [req.params.id]); res.json(emp);}catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/empleados/:id', async (req,res)=>{
  try{ const nid=await getNegocioId(req); await pool.query('DELETE FROM empleados WHERE id=$1 AND negocio_id=$2', [req.params.id,nid]); res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/empleados/:id/horarios', async (req,res)=>{
  try{ const {rows}=await pool.query('SELECT * FROM empleado_horarios WHERE empleado_id=$1 ORDER BY dia_semana, hora', [req.params.id]); res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/empleados/:id/horarios', async (req,res)=>{
  try{ const {horarios}=req.body; // [{dia_semana,hora,activo}]
    await pool.query('DELETE FROM empleado_horarios WHERE empleado_id=$1', [req.params.id]);
    for(const h of horarios) await pool.query('INSERT INTO empleado_horarios (empleado_id,dia_semana,hora,activo) VALUES ($1,$2,$3,$4)', [req.params.id, h.dia_semana, h.hora, h.activo!==false]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/empleados/:id/dias-bloqueados', async (req,res)=>{
  try{ const {rows}=await pool.query('SELECT * FROM empleado_dias_bloqueados WHERE empleado_id=$1 ORDER BY fecha', [req.params.id]); res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/empleados/:id/dias-bloqueados', async (req,res)=>{
  try{ const {fecha, motivo}=req.body; await pool.query('INSERT INTO empleado_dias_bloqueados (empleado_id,fecha,motivo) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, fecha, motivo||'']); res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/empleados/:id/dias-bloqueados/:fecha', async (req,res)=>{
  try{ await pool.query('DELETE FROM empleado_dias_bloqueados WHERE empleado_id=$1 AND fecha=$2', [req.params.id, req.params.fecha]); res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
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
      'SELECT s.*, c.nombre as categoria_nombre, c.color as categoria_color FROM servicios s LEFT JOIN categorias c ON c.id=s.categoria_id WHERE s.activo = true AND s.negocio_id=$1 ORDER BY s.id', [negocioId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/servicios', async (req,res)=>{
  try{ const nid=await getNegocioId(req); const {nombre, descripcion, precio, duracion, icono, categoria_id}=req.body; if(!nombre||!precio) return res.status(400).json({error:'Nombre y precio requeridos'}); const {rows:[s]}=await pool.query('INSERT INTO servicios (negocio_id,nombre,descripcion,precio,duracion,icono,categoria_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [nid,nombre,descripcion||'',precio,duracion||30,icono||'✂️',categoria_id||null]); res.status(201).json(s);}catch(e){res.status(500).json({error:e.message});}
});
app.patch('/api/servicios/:id', async (req,res)=>{
  try{ const nid=await getNegocioId(req); const {nombre, descripcion, precio, duracion, icono, categoria_id, activo}=req.body; const {rows:[s]}=await pool.query('UPDATE servicios SET nombre=COALESCE($1,nombre), descripcion=COALESCE($2,descripcion), precio=COALESCE($3,precio), duracion=COALESCE($4,duracion), icono=COALESCE($5,icono), categoria_id=$6, activo=COALESCE($7,activo) WHERE id=$8 AND negocio_id=$9 RETURNING *', [nombre,descripcion,precio,duracion,icono,categoria_id,activo,req.params.id,nid]); res.json(s);}catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/servicios/:id', async (req,res)=>{
  try{ const nid=await getNegocioId(req); await pool.query('UPDATE servicios SET activo=false WHERE id=$1 AND negocio_id=$2', [req.params.id,nid]); res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════
//  ENDPOINTS — DISPONIBILIDAD
// ════════════════════════════════════════
app.get('/api/disponibilidad', async (req, res) => {
  const { fecha, servicio_id, empleado_id } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
  try {
    const negocioId = await getNegocioId(req);
    const bloqueado = await pool.query('SELECT id FROM dias_bloqueados WHERE fecha=$1 AND negocio_id=$2', [fecha, negocioId]);
    if (bloqueado.rows.length > 0) return res.json({ disponible: false, horas: [] });
    const toMin = t => { const [h,m]=String(t).split(':').map(Number); return h*60+m; };
    // Si se pide por servicio, filtrar empleados por categoría del servicio
    let empleados = [];
    if(servicio_id){
      const svc = (await pool.query('SELECT categoria_id FROM servicios WHERE id=$1 AND negocio_id=$2', [servicio_id, negocioId])).rows[0];
      if(svc && svc.categoria_id){
        const er = await pool.query(`SELECT e.id FROM empleados e JOIN empleado_categorias ec ON ec.empleado_id=e.id WHERE e.negocio_id=$1 AND e.activo=true AND ec.categoria_id=$2`, [negocioId, svc.categoria_id]);
        empleados = er.rows.map(r=>r.id);
      } else {
        const er = await pool.query('SELECT id FROM empleados WHERE negocio_id=$1 AND activo=true', [negocioId]);
        empleados = er.rows.map(r=>r.id);
      }
      if(empleado_id) empleados = empleados.filter(id=>id==empleado_id);
      if(empleados.length===0) return res.json({ disponible: true, horas: [] });
    }
    // Horarios: si hay empleados, usar empleado_horarios, si no global
    let horarios=[];
    if(empleados.length>0){
      // empleados específicos: horas donde al menos un empleado esté activo y no bloqueado ese día
      const dia = new Date(fecha+'T12:00:00').getDay();
      const blockedEmps = (await pool.query('SELECT empleado_id FROM empleado_dias_bloqueados WHERE fecha=$1 AND empleado_id = ANY($2)', [fecha, empleados])).rows.map(r=>r.empleado_id);
      const activos = empleados.filter(id=> !blockedEmps.includes(id));
      if(activos.length===0) return res.json({ disponible: false, horas: [] });
      const hr = await pool.query('SELECT DISTINCT hora FROM empleado_horarios WHERE empleado_id = ANY($1) AND dia_semana=$2 AND activo=true ORDER BY hora', [activos, dia]);
      horarios = hr.rows;
      // reservadas por empleado
      const {rows: reservadas} = await pool.query(`SELECT c.hora, s.duracion, c.empleado_id FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.fecha=$1 AND c.negocio_id=$2 AND c.estado!='cancelada' AND c.empleado_id = ANY($3)`, [fecha, negocioId, activos]);
      const horas = horarios.map(h=>{
        const sm=toMin(h.hora);
        // disponible si existe al menos un empleado libre en ese slot
        const ocupados = reservadas.filter(r=>{ const s=toMin(r.hora), e=s+(r.duracion||30); return sm>=s && sm<e; }).map(r=>r.empleado_id);
        const libres = activos.filter(id=> !ocupados.includes(id));
        return { hora: h.hora, disponible: libres.length>0, empleados_disponibles: libres };
      });
      return res.json({ disponible: true, horas });
    } else {
      const { rows: reservadas } = await pool.query(`SELECT c.hora, s.duracion FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.fecha=$1 AND c.negocio_id=$2 AND c.estado!='cancelada'`, [fecha, negocioId]);
      const { rows: hrs } = await pool.query(`SELECT hora FROM horarios_trabajo WHERE dia_semana=$1 AND negocio_id=$2 AND activo=true ORDER BY hora`, [new Date(fecha+'T12:00:00').getDay(), negocioId]);
      const horas = hrs.map(h=>{ const sm=toMin(h.hora); const ocup=reservadas.some(r=>{const s=toMin(r.hora),e=s+(r.duracion||30);return sm>=s&&sm<e;}); return {hora:h.hora, disponible:!ocup}; });
      return res.json({ disponible: true, horas });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════
//  ENDPOINTS — CITAS
// ════════════════════════════════════════
app.post('/api/citas', async (req, res) => {
  const { nombre, telefono, email, servicio_id, fecha, hora, comentarios, notificar, empleado_id: reqEmp } = req.body;
  if (!nombre || !telefono || !servicio_id || !fecha || !hora) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  try {
    const negocioId = await getNegocioId(req);
    const { rows: [servicio] } = await pool.query(
      'SELECT * FROM servicios WHERE id = $1 AND negocio_id=$2', [servicio_id, negocioId]
    );
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado para este negocio' });
    const toMin = t => { const [h,m]=String(t).split(':').map(Number); return h*60+m; };
    const ns = toMin(hora), ne = ns + (servicio.duracion||30);
    // Determinar empleado: si viene reqEmp validar, si no auto-asignar disponible por categoría
    let empleadoId = reqEmp ? parseInt(reqEmp) : null;
    if(!empleadoId && servicio.categoria_id){
      // Buscar empleados de esa categoría libres en ese slot
      const {rows: cand} = await pool.query(`SELECT e.id FROM empleados e JOIN empleado_categorias ec ON ec.empleado_id=e.id WHERE e.negocio_id=$1 AND ec.categoria_id=$2 AND e.activo=true`, [negocioId, servicio.categoria_id]);
      for(const c of cand){
        const block = await pool.query('SELECT 1 FROM empleado_dias_bloqueados WHERE empleado_id=$1 AND fecha=$2', [c.id, fecha]);
        if(block.rows.length) continue;
        const dia = new Date(fecha+'T12:00:00').getDay();
        const hor = await pool.query('SELECT 1 FROM empleado_horarios WHERE empleado_id=$1 AND dia_semana=$2 AND hora=$3 AND activo=true', [c.id, dia, hora]);
        if(!hor.rows.length) continue;
        const {rows: ex} = await pool.query(`SELECT c.hora, s.duracion FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.fecha=$1 AND c.empleado_id=$2 AND c.estado!='cancelada'`, [fecha, c.id]);
        const ocupado = ex.some(r=>{ const s=toMin(r.hora), e=s+(r.duracion||30); return ns<e && ne>s; });
        if(!ocupado){ empleadoId=c.id; break; }
      }
      // Si no hay empleado específico pero hay empleados, permitir sin asignar (compatibilidad)
    } else if(empleadoId){
      // Validar que empleado puede hacer ese servicio y está libre
      if(servicio.categoria_id){
        const ok = await pool.query('SELECT 1 FROM empleado_categorias WHERE empleado_id=$1 AND categoria_id=$2', [empleadoId, servicio.categoria_id]);
        if(!ok.rows.length) return res.status(400).json({error:'Empleado no atiende esa categoría'});
      }
      const block = await pool.query('SELECT 1 FROM empleado_dias_bloqueados WHERE empleado_id=$1 AND fecha=$2', [empleadoId, fecha]);
      if(block.rows.length) return res.status(409).json({error:'Empleado no disponible ese día'});
      const {rows: ex} = await pool.query(`SELECT c.hora, s.duracion FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.fecha=$1 AND c.empleado_id=$2 AND c.estado!='cancelada'`, [fecha, empleadoId]);
      const ocupado = ex.some(r=>{ const s=toMin(r.hora), e=s+(r.duracion||30); return ns<e && ne>s; });
      if(ocupado) return res.status(409).json({ error: 'Empleado ocupado en ese horario (duración exacta).' });
    } else {
      // Sin empleados: validación global antigua
      const { rows: existentes } = await pool.query(`SELECT c.hora, s.duracion FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.fecha=$1 AND c.negocio_id=$2 AND c.estado!='cancelada' AND c.empleado_id IS NULL`, [fecha, negocioId]);
      const solapa = existentes.some(r=>{ const s=toMin(r.hora), e=s+(r.duracion||30); return ns<e && ne>s; });
      if(solapa) return res.status(409).json({ error: 'Este horario se solapa con otra cita (duración exacta). Elige otro.' });
    }

    const { rows: [cita] } = await pool.query(
      `INSERT INTO citas (nombre, telefono, email, servicio_id, fecha, hora, comentarios, estado, negocio_id, empleado_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente', $8, $9) RETURNING *`,
      [nombre, telefono, email, servicio_id, fecha, hora, comentarios || '', negocioId, empleadoId]
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
app.post('/api/citas/:id/comprobante', async (req,res)=>{
  try{
    const negocioId=await getNegocioId(req);
    const {rows:[cita]}=await pool.query('SELECT c.*, s.nombre as servicio_nombre, s.precio FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.id=$1 AND c.negocio_id=$2', [req.params.id, negocioId]);
    if(!cita) return res.status(404).json({error:'Cita no encontrada'});
    const waMsg=`✅ *Comprobante — ${cita.servicio_nombre}*\n\nHola ${cita.nombre}, tu cita está confirmada:\n📅 ${cita.fecha.toISOString().split('T')[0]} a las ${cita.hora}\n💈 ${cita.servicio_nombre} $${cita.precio}\n📍 Cosmopolitan Apizaco\n¡Te esperamos!`;
    const waUrl=buildWhatsAppUrl(cita.telefono, waMsg);
    const ok = await sendWhatsApp(cita.telefono, waMsg);
    res.json({ok:true, whatsappUrl: waUrl, sent: ok});
  }catch(e){ res.status(500).json({error:e.message}); }
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
const sleep = ms => new Promise(r=>setTimeout(r, ms));
const waTemplatesConfirm = [
  (n,s,h,f) => `Hola ${n} ✅ Tu cita de *${s}* está confirmada para ${f} a las ${h}. ¡Te esperamos en Cosmopolitan!`,
  (n,s,h,f) => `¡Gracias ${n}! 🙌 Reserva confirmada: *${s}* el ${f} ${h}. Responde *CONFIRMAR* si todo bien.`,
  (n,s,h,f) => `Hola ${n}, te confirmamos tu servicio *${s}* para ${f} a las ${h}. ¡Nos vemos pronto! ✂️`
];
const waTemplatesRecordatorio = [
  (n,s,h) => `Hola ${n} ⏰ Te recordamos tu cita de *${s}* hoy a las ${h}. ¡Te esperamos! Responde *CONFIRMAR* para confirmar.`,
  (n,s,h) => `¡Hola ${n}! Mañana tienes *${s}* a las ${h}. ¿Nos confirmas? 😊`,
  (n,s,h) => `Recordatorio ${n}: tu *${s}* es hoy ${h}. ¡No faltes! Cosmopolitan te espera.`
];
cron.schedule('*/5 * * * *', async () => {
  // Recordatorio 1 hora antes a cliente por WhatsApp + Telegram al negocio (pendiente y confirmada)
  try {
    const { rows: citas } = await pool.query(
      `SELECT c.*, s.nombre AS servicio_nombre, c.negocio_id FROM citas c JOIN servicios s ON c.servicio_id = s.id
       WHERE c.estado IN ('pendiente','confirmada') AND c.recordatorio_enviado = false
         AND ((c.fecha || ' ' || c.hora)::timestamp AT TIME ZONE 'America/Mexico_City') BETWEEN NOW() + INTERVAL '55 minutes' AND NOW() + INTERVAL '65 minutes'`
    );
    for (let i=0; i<citas.length; i++) {
      const cita = citas[i];
      const fechaLeg = new Date(cita.fecha + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
      const icon = cita.negocio_id===2 ? '🐴' : '✂️';
      const msgNegocio = `⏰ <b>Recordatorio — En 1 hora ${icon}</b>\n\n` +
        `👤 ${cita.nombre}\n📱 ${cita.telefono}\n💈 ${cita.servicio_nombre}\n📅 ${fechaLeg} a las ${cita.hora}\n` +
        (cita.comentarios ? `📝 Nota: ${cita.comentarios}` : '');
      await sendTelegram(msgNegocio, cita.negocio_id);
      // WhatsApp al cliente 1h antes — mensaje variado + delay anti-ban
      const tpl = waTemplatesRecordatorio[Math.floor(Math.random()*waTemplatesRecordatorio.length)];
      const waMsg = tpl(cita.nombre, cita.servicio_nombre, cita.hora);
      await sendWhatsApp(cita.telefono, waMsg);
      if(i < citas.length-1) await sleep(3000 + Math.floor(Math.random()*2000)); // 3-5s entre envíos
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

// ─── WHATSAPP BAILEYS ENDPOINTS ───────────────────────
// Soporta tanto /whatsapp/* como /api/whatsapp/* (frontend usa API_URL=/api)
for(const p of ['/whatsapp/status','/api/whatsapp/status']){
  app.get(p, (req,res)=> res.json(baileys ? baileys.getStatus() : {ready:false}));
}
for(const p of ['/whatsapp/qr','/api/whatsapp/qr']){
  app.get(p, (req,res)=>{
    if(!baileys) return res.status(500).send('Baileys no inicializado');
    const qr=baileys.getQR();
    if(!qr) return res.json({qr:null, ready: baileys.getStatus().ready});
    res.json({qr, ready:false});
  });
}
for(const p of ['/whatsapp/qr-image','/api/whatsapp/qr-image']){
  app.get(p, async (req,res)=>{
    if(!baileys || !baileys.getQR()) return res.status(404).send('QR no disponible');
    try{
      const QR=require('qrcode');
      const png=await QR.toBuffer(baileys.getQR());
      res.type('png').send(png);
    }catch(e){ res.status(500).send(e.message); }
  });
}

// ─── ADMIN AUTO-AYUDA ───────────────────────────────────
for(const p of ['/admin/health','/api/admin/health']){
  app.get(p, async (req,res)=>{
    try{
      const db = await pool.query('SELECT 1 as ok').then(()=>true).catch(()=>false);
      const wa = baileys ? baileys.getStatus() : {ready:false};
      const citas = await pool.query("SELECT COUNT(*) as c FROM citas WHERE fecha = (NOW() AT TIME ZONE 'America/Mexico_City')::date").then(r=>r.rows[0].c).catch(()=>0);
      res.json({ db: db?'ok':'error', whatsapp: wa, citas_hoy: parseInt(citas), uptime: process.uptime(), env: process.env.FRONTEND_URL||'*' });
    }catch(e){ res.status(500).json({error:e.message}); }
  });
}
for(const p of ['/admin/whatsapp/reconnect','/api/admin/whatsapp/reconnect']){
  app.post(p, async (req,res)=>{
    try{
      await pool.query('DELETE FROM whatsapp_auth'); await pool.query('DELETE FROM whatsapp_lock');
      if(baileys) { try{ baileys.getStatus().ready=false; }catch(e){} }
      // Reiniciar Baileys
      if(baileys) setTimeout(()=> baileys.initWhatsApp(), 1000);
      res.json({ok:true, msg:'Sesión limpiada, nuevo QR en 10s'});
    }catch(e){ res.status(500).json({error:e.message}); }
  });
}
for(const p of ['/admin/recordatorios/reenviar','/api/admin/recordatorios/reenviar']){
  app.post(p, async (req,res)=>{
    try{
      const {rows: citas} = await pool.query(`SELECT c.*, s.nombre as servicio_nombre FROM citas c JOIN servicios s ON s.id=c.servicio_id WHERE c.fecha=(NOW() AT TIME ZONE 'America/Mexico_City')::date AND c.estado IN ('pendiente','confirmada') ORDER BY c.hora LIMIT 20`);
      let enviados=0;
      for(const cita of citas){
        const waMsg=`Hola ${cita.nombre} ⏰ Te recordamos tu cita de *${cita.servicio_nombre}* hoy a las ${cita.hora}. ¡Te esperamos en Cosmopolitan!`;
        const ok=await sendWhatsApp(cita.telefono, waMsg);
        if(ok) enviados++;
        await new Promise(r=>setTimeout(r,1500));
      }
      res.json({ok:true, enviados, total: citas.length, detalle: citas.map(c=>`${c.hora} ${c.nombre} ${c.estado}`).join(' | ')});
    }catch(e){ res.status(500).json({error:e.message}); }
  });
}
for(const p of ['/admin/horarios/reset','/api/admin/horarios/reset']){
  app.post(p, async (req,res)=>{
    try{
      const nid=await getNegocioId(req);
      const horas=['10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00','19:30'];
      await pool.query('DELETE FROM horarios_trabajo WHERE negocio_id=$1', [nid]);
      for(let d=1; d<=6; d++) for(const h of horas) await pool.query('INSERT INTO horarios_trabajo (negocio_id, dia_semana, hora) VALUES ($1,$2,$3)', [nid,d,h]);
      res.json({ok:true});
    }catch(e){ res.status(500).json({error:e.message}); }
  });
}
for(const p of ['/admin/whatsapp/test','/api/admin/whatsapp/test']){
  app.post(p, async (req,res)=>{
    try{
      const {telefono, mensaje} = req.body;
      if(!telefono) return res.status(400).json({error:'telefono requerido'});
      const text=mensaje||`Prueba Cosmopolitan ✅ ${new Date().toLocaleString('es-MX')} — si ves esto, Baileys está OK`;
      const ok=await sendWhatsApp(telefono, text);
      const st=baileys?baileys.getStatus():{ready:false};
      res.json({ok, sent: ok, status: st, to: telefono});
    }catch(e){ res.status(500).json({error:e.message}); }
  });
}

// Inicializar Baileys (no bloquea el arranque)
if(baileys) baileys.initWhatsApp().catch(e=>console.error('[WA] init fail', e.message));

// ════════════════════════════════════════
//  CONFIGURACIÓN DEL FRONTEND
// ════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✂️  BarberElite API (multi-negocio) corriendo en puerto ${PORT}`));
