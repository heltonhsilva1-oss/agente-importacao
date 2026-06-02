'use strict';
// Rota Express que recebe webhooks da Uazapi

const axios = require('axios');
const { logger } = require('./logger');
const { handleMessage } = require('./menu');

const OPERATOR_PHONE = process.env.OPERATOR_PHONE || '5511995715042';
const AGENT_PHONE    = process.env.AGENT_PHONE    || '5511961482602';

// Deduplicação: guarda IDs de mensagens processadas nos últimos 30 segundos
const processedIds = new Map();
function isDuplicate(id) {
  if (!id) return false;
  if (processedIds.has(id)) return true;
  processedIds.set(id, Date.now());
  // Limpa entradas com mais de 30 segundos
  const cutoff = Date.now() - 30000;
  for (const [k, v] of processedIds) if (v < cutoff) processedIds.delete(k);
  return false;
}

// Envia texto direto via Uazapi (sem passar pelo menu)
async function notifyOperator(text) {
  try {
    await axios.post(
      `${process.env.UAZAPI_SERVER_URL}/send/text`,
      { number: OPERATOR_PHONE, text },
      { headers: { token: process.env.UAZAPI_INSTANCE_TOKEN, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
  } catch (_) {}
}

// Extrai phone, body, type, mediaUrl, mimeType e isFromMe de qualquer formato Uazapi
function parsePayload(raw) {
  // ── Formato Uazapi GO webhook global ───────────────────────────────────────
  // { BaseUrl, EventType, chat, message: { phone, text, fromMe, mediaUrl, ... } }
  if (raw.BaseUrl || raw.EventType) {
    const msg = raw.message || {};

    // Determina o identificador correto para responder:
    // - @lid  → número de business do WhatsApp: usa o LID completo (ex: 266537751552115@lid)
    // - @s.whatsapp.net → número normal: extrai só os dígitos
    // - sem sufixo → tenta como número de telefone
    const sender = msg.sender || msg.jid || msg.remoteJid || '';
    let phone;
    if (sender.includes('@lid')) {
      phone = sender; // mantém o formato LID completo para envio
    } else if (sender.includes('@s.whatsapp.net') || sender.includes('@c.us')) {
      phone = sender.replace(/@[^@]+$/, '').replace(/\D/g, '');
    } else {
      phone = msg.phone || msg.number || sender.replace(/@[^@]+$/, '');
    }

    let type = (msg.messageType || msg.type || 'text').toLowerCase()
      .replace('message', '').replace('msg', '').trim() || 'text';
    if (['conversation', 'extendedtext', ''].includes(type)) type = 'text';

    return {
      phone,
      body:     String(msg.text || msg.body || msg.caption || ''),
      type,
      mediaUrl: msg.mediaUrl || msg.fileUrl || msg.imageUrl || null,
      mimeType: msg.mimetype || msg.mimeType || null,
      isFromMe: msg.fromMe === true || msg.isFromMe === true,
    };
  }

  // ── Formato Uazapi GO (nativo plano) ──────────────────────────────────────
  // { owner, sender, text, messageType, fromMe, phone, chatid, ... }
  if (raw.owner || raw.sender) {
    const phone = raw.phone
      || (raw.chatid || '').replace(/@s\.whatsapp\.net|@c\.us/g, '')
      || (raw.sender || '').replace(/@s\.whatsapp\.net|@c\.us/g, '');

    let type = (raw.messageType || 'text').toLowerCase()
      .replace('message', '').replace('msg', '').trim() || 'text';
    if (['conversation', 'extendedtext', ''].includes(type)) type = 'text';

    return {
      phone,
      body:     String(raw.text || raw.body || raw.caption || ''),
      type,
      mediaUrl: raw.mediaUrl || raw.fileUrl || raw.imageUrl || null,
      mimeType: raw.mimetype || raw.mimeType || null,
      isFromMe: raw.fromMe === true,
    };
  }

  // ── Formato com data.key (Baileys / Uazapi v2 antigo) ─────────────────────
  if (raw.data?.key) {
    const d   = raw.data;
    const msg = d.message || {};
    const phone = d.phone
      || (d.key?.remoteJid || '').replace(/@s\.whatsapp\.net|@c\.us/g, '');

    let body_ = '', type = 'text', mediaUrl = null, mimeType = null;
    if (msg.conversation)                   { body_ = msg.conversation; }
    else if (msg.extendedTextMessage?.text) { body_ = msg.extendedTextMessage.text; }
    else if (msg.imageMessage)    { body_ = msg.imageMessage.caption    || ''; mediaUrl = msg.imageMessage.url;    mimeType = msg.imageMessage.mimetype    || 'image/jpeg';       type = 'image'; }
    else if (msg.documentMessage) { body_ = msg.documentMessage.caption || ''; mediaUrl = msg.documentMessage.url; mimeType = msg.documentMessage.mimetype || 'application/pdf';  type = 'document'; }
    else if (msg.audioMessage)    { type = 'audio'; }
    else if (msg.videoMessage)    { body_ = msg.videoMessage.caption    || ''; mediaUrl = msg.videoMessage.url;    mimeType = msg.videoMessage.mimetype    || 'video/mp4';         type = 'video'; }

    return { phone, body: String(body_), type, mediaUrl, mimeType, isFromMe: d.key?.fromMe === true };
  }

  // ── Formato plano { phone/number, body/text, type } ───────────────────────
  if (raw.phone || raw.number) {
    return {
      phone:    raw.phone || raw.number,
      body:     String(raw.body || raw.text || raw.message || raw.caption || ''),
      type:     raw.type || 'text',
      mediaUrl: raw.mediaUrl || null,
      mimeType: raw.mimeType || null,
      isFromMe: raw.isFromMe === true || raw.fromMe === true,
    };
  }

  return null;
}

function setupWebhook(app) {
  // ── Rota principal ─────────────────────────────────────────────────────────
  app.post('/webhook', async (req, res) => {
    res.status(200).json({ ok: true }); // responde rápido

    const raw = req.body;
    // Loga payload completo para mensagens de mídia (para descobrir campo da URL)
    const isMedia = raw.message?.messageType && !['Conversation','ExtendedTextMessage','conversation','text'].includes(raw.message.messageType);
    if (isMedia) logger.info('[webhook] MIDIA payload:', JSON.stringify(raw.message).slice(0, 3000));

    // Encaminha o payload bruto ao operador para diagnóstico (remova após confirmar funcionamento)
    const payloadStr = JSON.stringify(raw, null, 2).slice(0, 1200);
    await notifyOperator(`📦 WEBHOOK:\n${payloadStr}`);

    try {
      const parsed = parsePayload(raw);

      if (!parsed) {
        logger.warn('[webhook] Formato não reconhecido');
        return;
      }

      const { phone, body, type, mediaUrl, mimeType, isFromMe } = parsed;

      logger.info(`[webhook] phone=${phone} type=${type} fromMe=${isFromMe} body="${(body||'').slice(0,60)}"`);

      if (isFromMe)                        return; // mensagem enviada pelo agente
      if (!phone)                          return;
      if ((phone + '').includes('@g.us'))  return; // grupo

      // Proteção anti-loop: ignora mensagens do próprio número do agente
      const phoneDigits = (phone + '').replace(/\D/g, '');
      const agentDigits = (AGENT_PHONE + '').replace(/\D/g, '');
      if (phoneDigits === agentDigits || phoneDigits.endsWith(agentDigits)) return;

      // Deduplicação: ignora se a mesma mensagem já foi processada
      const msgId = raw.message?.id || raw.message?.messageid || raw.id || '';
      if (msgId && isDuplicate(msgId)) {
        logger.info(`[webhook] Duplicata ignorada: ${msgId}`);
        return;
      }

      await handleMessage(phone, type, body, mediaUrl, mimeType);
    } catch (err) {
      logger.error('[webhook] Erro:', err.message, err.stack?.slice(0, 300));
    }
  });

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  // ── Echo de teste ──────────────────────────────────────────────────────────
  app.post('/echo', (req, res) => {
    logger.info('[echo]', JSON.stringify(req.body));
    res.json({ received: req.body });
  });
}

module.exports = { setupWebhook };
