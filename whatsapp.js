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

async function initWhatsApp(){
  try{
    const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
    // Intentar cargar desde Supabase
    const sup = await useSupabaseAuthState();
    let state, saveCreds;
    if(sup.state.creds){
      state = sup.state;
      saveCreds = async ()=>{
        // guardar creds actualizados
        const creds = state.creds;
        await pool.query('INSERT INTO whatsapp_auth (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', ['creds', JSON.stringify(creds)]);
      };
      console.log('[WA] Creds cargados desde Supabase');
    } else {
      // fallback a memoria (primera vez)
      state = { creds: undefined, keys: sup.state.keys };
      saveCreds = sup.saveCreds;
    }

    sock = makeWASocket({
      auth: state,
      logger: pino({level:'silent'}),
      printQRInTerminal: false,
      browser: ['BarberElite','Chrome','1.0'],
    });

    sock.ev.on('creds.update', async ()=>{
      await saveCreds();
      // también guardar keys via sup.state.keys.set ya lo hace
      // guardar creds en map
      if(sock.authState?.creds){
        await pool.query('INSERT INTO whatsapp_auth (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', ['creds', JSON.stringify(sock.authState.creds)]);
      }
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
      }
      if(connection==='close'){
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[WA] Desconectado', lastDisconnect?.error, 'reconnect', shouldReconnect);
        ready=false;
        if(shouldReconnect) setTimeout(initWhatsApp, 3000);
      }
    });

    // Patch: interceptar keys.set para persistir
    const origKeysSet = state.keys.set;
    state.keys.set = async (data)=>{
      await origKeysSet(data);
    };

  }catch(e){ console.error('[WA] init error', e.message); }
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
