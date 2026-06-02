'use strict';
// Rota Express que recebe webhooks da Uazapi

const { logger } = require('./logger');
const { handleMessage } = require('./menu');

const AGENT_PHONE = process.env.AGENT_PHONE || '5511961482602';

// Normaliza os diferentes formatos de payload da Uazapi para uma estrutura comum
function parsePayload(body) {
  // Formato Uazapi GO (formato nativo): { phone/chatid, text, messageType, fromMe, sender }
  if (body?.owner || body?.sender) {
    const phone = body.phone || (body.chatid || '').replace(/@s\.whatsapp\.net|@c\.us/g, '');
    const isFromMe = body.fromMe === true;
    let type = (body.messageType || 'text').toLowerCase().replace('message', '').trim() || 'text';
    if (type === 'conversation' || type === 'extendedtext') type = 'text';

    return {
      phone,
      body: body.text || body.caption || '',
      type,
      mediaUrl: body.mediaUrl || body.fileUrl || null,
      mimeType: body.mimetype || body.mimeType || null,
      isFromMe,
    };
  }

  // Formato A (Uazapi v2): { event, data: { key, message, messageType, phone } }
  if (body?.data?.key) {
    const d = body.data;
    const raw = d.key?.remoteJid || '';
    const phone = d.phone || raw.replace(/@s\.whatsapp\.net|@c\.us/g, '');
    const isFromMe = d.key?.fromMe === true;
    const msg = d.message || {};

    let body_ = '';
    let type = d.messageType || 'text';
    let mediaUrl = null;
    let mimeType = null;

    if (msg.conversation) {
      body_ = msg.conversation;
      type = 'text';
    } else if (msg.extendedTextMessage?.text) {
      body_ = msg.extendedTextMessage.text;
      type = 'text';
    } else if (msg.imageMessage) {
      body_ = msg.imageMessage.caption || '';
      mediaUrl = msg.imageMessage.url || null;
      mimeType = msg.imageMessage.mimetype || 'image/jpeg';
      type = 'image';
    } else if (msg.documentMessage) {
      body_ = msg.documentMessage.caption || '';
      mediaUrl = msg.documentMessage.url || null;
      mimeType = msg.documentMessage.mimetype || 'application/pdf';
      type = 'document';
    } else if (msg.audioMessage) {
      type = 'audio';
    } else if (msg.videoMessage) {
      body_ = msg.videoMessage.caption || '';
      mediaUrl = msg.videoMessage.url || null;
      mimeType = msg.videoMessage.mimetype || 'video/mp4';
      type = 'video';
    }

    return { phone, body: body_, type, mediaUrl, mimeType, isFromMe };
  }

  // Formato B (Uazapi v1): { type, data: { phone, body, type, mediaUrl, isFromMe } }
  if (body?.data?.phone) {
    const d = body.data;
    return {
      phone: d.phone,
      body: d.body || d.message || '',
      type: d.type || 'text',
      mediaUrl: d.mediaUrl || null,
      mimeType: d.mimeType || null,
      isFromMe: d.isFromMe === true,
    };
  }

  // Formato C: payload plano { phone, body, type, ... }
  if (body?.phone) {
    return {
      phone: body.phone,
      body: body.body || body.message || '',
      type: body.type || 'text',
      mediaUrl: body.mediaUrl || null,
      mimeType: body.mimeType || null,
      isFromMe: body.isFromMe === true,
    };
  }

  return null;
}

function setupWebhook(app) {
  app.post('/webhook', async (req, res) => {
    // Responde imediatamente para evitar timeout da Uazapi
    res.status(200).json({ ok: true });

    try {
      const parsed = parsePayload(req.body);

      if (!parsed) {
        logger.warn('[webhook] Payload não reconhecido:', JSON.stringify(req.body).slice(0, 300));
        return;
      }

      const { phone, body, type, mediaUrl, mimeType, isFromMe } = parsed;

      if (isFromMe) return;
      if (!phone || phone.includes('@g.us')) return; // grupo, ignora

      logger.info(`[webhook] ${phone} | ${type} | "${(body || '').slice(0, 60)}"`);

      await handleMessage(phone, type, body, mediaUrl, mimeType);
    } catch (err) {
      logger.error('[webhook] Erro ao processar mensagem:', err);
    }
  });

  // Health check para o Railway
  app.get('/health', (_req, res) => res.json({ ok: true }));
}

module.exports = { setupWebhook };
