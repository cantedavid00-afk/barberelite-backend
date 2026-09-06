// Baileys con creds en Supabase (sobrevive a sleep/deploy de Render Free)
const { Pool } = require('pg');
const pino = require('pino');
const QRCode = require('qrcode-terminal');
let sock=null, qrStr=null, ready=false;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });

// Auth adaptado a Supabase
async function useSupabaseAuthState(){
  // cargar
  const {rows} = await pool.query('SELECT id, data FROM whatsapp_auth');
  const map=new Map(rows.map(r=>[r.id, r.data]));
  // funciones
  async function saveCreds(){
    // Baileys llama a saveCreds sin args, pero nosotros guardamos todo el map
    // Se sobrescribe vía evento creds.update -> guardamos keys individuales
  }
  return {
    state: {
      creds: map.get('creds') || undefined,
      keys: {
        get: (type, ids)=>{
          const out={};
          for(const id of ids){
            const key=`${type}-${id}`;
            if(map.has(key)) out[id]=map.get(key);
          }
          return out;
        },
        set: async (data)=>{
          for(const type in data){
            for(const id in data[type]){
              const key=`${type}-${id}`;
              const value=data[type][id];
              if(value) map.set(key, value);
              else map.delete(key);
              const v = value ? JSON.stringify(value) : null;
              if(value) await pool.query('INSERT INTO whatsapp_auth (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', [key, JSON.stringify(value)]);
              else await pool.query('DELETE FROM whatsapp_auth WHERE id=$1', [key]);
            }
          }
        }
      }
    },
    saveCreds: async ()=>{
      // guardar creds
      if(map.get('creds')){
        await pool.query('INSERT INTO whatsapp_auth (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', ['creds', JSON.stringify(map.get('creds'))]);
      }
    },
    // helper para guardar creds inicial
    _map: map
  };
}

let initLock=false;
async function initWhatsApp(){
  if(initLock) return; initLock=true;
  if(process.env.ENABLE_WA === 'false'){
    console.log('[WA] Deshabilitado por ENABLE_WA=false (local)');
    initLock=false; return;
  }
  if(!process.env.DATABASE_URL){
    console.log('[WA] No DATABASE_URL');
    initLock=false; return;
  }
  // Lock simple via DB para que solo 1 instancia use Baileys
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_lock (id INT PRIMARY KEY, locked_at TIMESTAMPTZ, instance TEXT)`);
    const {rows} = await pool.query(`SELECT locked_at, instance FROM whatsapp_lock WHERE id=1`);
    if(rows.length && rows[0].locked_at && new Date() - new Date(rows[0].locked_at) < 90*1000){
      console.log('[WA] Otro proceso tiene lock reciente ('+rows[0].instance+'), salto init');
      initLock=false; return;
    }
    await pool.query(`INSERT INTO whatsapp_lock (id, locked_at, instance) VALUES (1, now(), $1) ON CONFLICT (id) DO UPDATE SET locked_at=now(), instance=EXCLUDED.instance`, [process.env.RENDER_INSTANCE_ID||'render']);
  }catch(e){ console.log('[WA] lock check error', e.message); }
  try{
    const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = await import('@whiskeysockets/baileys');
    // Intentar cargar desde Supabase
    const sup = await useSupabaseAuthState();
    let state, saveCreds;
    // Si no hay creds, generar unos nuevos con initAuthCreds (evita crash creds.me undefined)
    let creds = sup.state.creds;
    if(!creds){
      creds = initAuthCreds();
      // guardar inicial
      await pool.query('INSERT INTO whatsapp_auth (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', ['creds', JSON.stringify(creds, BufferJSON.replacer)]);
      sup._map.set('creds', creds);
      console.log('[WA] Creds nuevos generados');
    } else {
      console.log('[WA] Creds cargados desde Supabase');
      // Decodificar con BufferJSON si viene como string
      if(typeof creds === 'string') creds = JSON.parse(creds, BufferJSON.reviver);
      else creds = JSON.parse(JSON.stringify(creds), BufferJSON.reviver);
    }
    state = { creds, keys: sup.state.keys };
    saveCreds = async ()=>{
      const data = JSON.stringify(state.creds, BufferJSON.replacer);
      sup._map.set('creds', state.creds);
      await pool.query('INSERT INTO whatsapp_auth (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', ['creds', data]);
    };

    sock = makeWASocket({
      auth: state,
      logger: pino({level:'silent'}),
      printQRInTerminal: false,
      browser: ['BarberElite','Chrome','1.0'],
    });

    sock.ev.on('creds.update', async ()=>{
      // Baileys envía creds actualizados aquí
      await saveCreds();
    });

    sock.ev.on('connection.update', async (u)=>{
      const {connection, lastDisconnect, qr} = u;
      if(qr){
        qrStr=qr;
        console.log('[WA] QR generado — escanea en /whatsapp/qr o logs:');
        QRCode.generate(qr, {small:true});
      }
      if(connection==='open'){
        ready=true; qrStr=null;
        console.log('[WA] Conectado ✅');
        // heartbeat para lock
        setInterval(async()=>{
          if(ready) await pool.query(`UPDATE whatsapp_lock SET locked_at=now() WHERE id=1`).catch(()=>{});
        }, 30000);
      }
      if(connection==='close'){
        const code = lastDisconnect?.error?.output?.statusCode;
        const isConflict = code===440;
        if(isConflict){
          console.log('[WA] Conflict 440 — sesión duplicada. Liberando lock y esperando 60s.');
          ready=false;
          try{ await pool.query('DELETE FROM whatsapp_lock WHERE id=1'); }catch(e){}
          try{ await sock.logout(); }catch(e){}
          try{ sock.end(true); }catch(e){}
          sock=null; initLock=false;
          setTimeout(initWhatsApp, 60000);
          return;
        }
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log('[WA] Desconectado', lastDisconnect?.error, 'reconnect', shouldReconnect);
        ready=false;
        try{ await pool.query('DELETE FROM whatsapp_lock WHERE id=1'); }catch(e){}
        try{ sock=null; }catch(e){}
        initLock=false;
        if(shouldReconnect) setTimeout(initWhatsApp, 10000);
      }
    });

    // Patch: interceptar keys.set para persistir
    const origKeysSet = state.keys.set;
    state.keys.set = async (data)=>{
      await origKeysSet(data);
    };

  }catch(e){ console.error('[WA] init error', e.message); } finally { initLock=false; }
}

function getStatus(){ return { ready, hasQR: !!qrStr }; }
function getQR(){ return qrStr; }

async function sendViaBaileys(phone, text){
  if(!sock || !ready) { console.log('[WA] no ready, phone', phone); return false; }
  const jid = phone.replace(/\D/g,'').replace(/^0+/,'') + '@s.whatsapp.net';
  // asegurar formato internacional
  let target = jid;
  if(!target.startsWith('52')) {
    const clean=phone.replace(/\D/g,'');
    target = (clean.startsWith('52')?clean:'52'+clean)+'@s.whatsapp.net';
  }
  try{
    await sock.sendMessage(target, { text });
    console.log('[WA] enviado a', target);
    return true;
  }catch(e){ console.error('[WA] send error', e.message); return false; }
}

module.exports = { initWhatsApp, sendViaBaileys, getStatus, getQR };
