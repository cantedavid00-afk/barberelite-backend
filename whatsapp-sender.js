// whatsapp-sender.js — lógica pura de envío con Baileys
function jidANumero(jid) {
  const limpio = (jid || '').replace(/@[^\s]*/g, '').replace(/:\d+$/, '').trim()
  return limpio.startsWith('52') ? `+${limpio}` : limpio
}
function limpiarTelefono(num) {
  return (num || '').replace(/\D/g, '').replace(/^1/, '')
}
function getContenidoMensaje(msg) {
  let full = msg?.message
  for (let i = 0; i < 4 && full; i++) {
    if (full.ephemeralMessage?.message) full = full.ephemeralMessage.message
    else if (full.viewOnceMessage?.message) full = full.viewOnceMessage.message
    else if (full.viewOnceMessageV2?.message) full = full.viewOnceMessageV2.message
    else if (full.viewOnceMessageV2Extension?.message) full = full.viewOnceMessageV2Extension.message
    else if (full.documentWithCaptionMessage?.message) full = full.documentWithCaptionMessage.message
    else break
  }
  return full
}
async function responderMensaje(sock, msg, texto) {
  if (!sock) return null
  const jid = msg.key?.remoteJid
  if (!jid) return null
  try {
    const result = await sock.sendMessage(jid, { text: texto }, { quoted: msg })
    try {
      await sock.chatModify({
        markRead: false,
        lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }],
      }, jid)
    } catch {}
    return result
  } catch (err) {
    console.warn('[sender] Error responderMensaje:', err.message)
    return null
  }
}
async function enviarTextoANumeros(sock, numeros, mensaje) {
  if (!sock?.user) {
    console.warn('[sender] sock.user no disponible')
    return 0
  }
  const botUser = jidANumero(sock.user.id || '').replace(/^\+/, '')
  const enviados = new Set()
  let exitosos = 0
  for (const num of numeros) {
    try {
      const telefono = limpiarTelefono(num)
      let jid = num.includes('@') ? num : `${telefono}@s.whatsapp.net`
      jid = jid.replace(/@c\.us$/, '@s.whatsapp.net')
      if (telefono && sock.onWhatsApp) {
        const resultado = await sock.onWhatsApp(telefono).catch(() => undefined)
        const contacto = resultado?.find(r => r.exists && r.jid)
        if (contacto?.jid) {
          jid = contacto.jid.replace(/@c\.us$/, '@s.whatsapp.net')
        } else if (resultado && !contacto) {
          console.warn(`[sender] ${telefono} no aparece como usuario válido`)
          continue
        }
      }
      const destinoUser = jidANumero(jid).replace(/^\+/, '')
      if (destinoUser && botUser && destinoUser === botUser) {
        console.warn(`[sender] ${jid} es el propio bot`)
        continue
      }
      if (enviados.has(destinoUser)) continue
      enviados.add(destinoUser)
      await sock.sendMessage(jid, { text: mensaje })
      exitosos++
    } catch (err) {
      console.warn(`[sender] Error enviando a ${num}:`, err.message)
    }
  }
  return exitosos
}
async function enviarImagenANumeros(sock, numeros, base64, caption = '', mimetype = 'image/jpeg') {
  if (!sock?.user) return 0
  const buf = Buffer.from(base64, 'base64')
  let enviados = 0
  for (const num of numeros) {
    try {
      const telefono = limpiarTelefono(num)
      let jid = num.includes('@') ? num : `${telefono}@s.whatsapp.net`
      jid = jid.replace(/@c\.us$/, '@s.whatsapp.net')
      if (telefono && sock.onWhatsApp) {
        const resultado = await sock.onWhatsApp(telefono).catch(() => undefined)
        const contacto = resultado?.find(r => r.exists && r.jid)
        if (contacto?.jid) {
          jid = contacto.jid.replace(/@c\.us$/, '@s.whatsapp.net')
        } else if (resultado && !contacto) continue
      }
      await sock.sendMessage(jid, { image: buf, caption, mimetype })
      enviados++
    } catch (err) {
      console.warn(`[sender] Error enviando foto a ${num}:`, err.message)
    }
  }
  return enviados
}
async function enviarTextoAUnNumero(sock, telefono, mensaje) {
  const limpio = limpiarTelefono(telefono)
  const jid = `${limpio}@s.whatsapp.net`
  try {
    // Resolver JID real
    if (sock.onWhatsApp) {
      const r = await sock.onWhatsApp(limpio).catch(()=>undefined)
      const c = r?.find(x=>x.exists && x.jid)
      if(c?.jid) {
        await sock.sendMessage(c.jid.replace(/@c\.us$/,'@s.whatsapp.net'), { text: mensaje })
        return true
      }
    }
    await sock.sendMessage(jid, { text: mensaje })
    return true
  } catch (err) {
    console.warn(`[sender] Error enviando a ${telefono}:`, err.message)
    return false
  }
}
async function marcarChatNoLeido(sock, msg) {
  if (!sock || !msg.key?.remoteJid) return
  try {
    await sock.chatModify({
      markRead: false,
      lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }],
    }, msg.key.remoteJid)
  } catch {}
}
module.exports = {
  responderMensaje,
  enviarTextoANumeros,
  enviarImagenANumeros,
  enviarTextoAUnNumero,
  marcarChatNoLeido,
  jidANumero,
  limpiarTelefono,
}
