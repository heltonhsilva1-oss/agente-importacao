'use strict';
// Rota Express que recebe webhooks da Uazapi

const crypto = require('crypto');
const { logger } = require('./logger');
const { handleMessage } = require('./menu');
const {
  claimWebhookMessage,
  completeWebhookMessage,
  releaseWebhookMessage,
} = require('./firestore');

const AGENT_PHONE = process.env.AGENT_PHONE || '5511961482602';

function messageKey(id) {
  if (!id) return '';
  return crypto.createHash('sha256').update(String(id)).digest('hex');
}

function getWebhookSecret() {
  return String(process.env.WEBHOOK_PATH_SECRET || '').trim();
}

function isSecretConfigured(secret = getWebhookSecret()) {
  return secret.length >= 32;
}

function isValidSecret(recebido, esperado = getWebhookSecret()) {
  if (!recebido || !isSecretConfigured(esperado)) return false;

  const recebidoBuffer = Buffer.from(String(recebido));
  const esperadoBuffer = Buffer.from(String(esperado));
  if (recebidoBuffer.length !== esperadoBuffer.length) return false;
  return crypto.timingSafeEqual(recebidoBuffer, esperadoBuffer);
}

// Extrai phone, body, type, mediaUrl, mimeType e isFromMe do payload da Uazapi GO
function parsePayload(raw) {
  // ── Formato Uazapi GO webhook global ───────────────────────────────────────
  // { BaseUrl, EventType, chat, message: { sender_pn, content, messageType, ... } }
  if (raw.BaseUrl || raw.EventType) {
    const msg = raw.message || {};

    // sender_pn = número real ex: "5511969646851@s.whatsapp.net"
    // sender    = LID ex: "266537751552115@lid"
    const senderPn  = (msg.sender_pn || '').replace(/@[^@]+$/, '');
    const senderLid = msg.sender || '';
    const phone = senderPn || (senderLid.includes('@lid') ? senderLid : senderLid.replace(/@[^@]+$/, '').replace(/\D/g, ''));

    let type = (msg.messageType || msg.mediaType || 'text').toLowerCase()
      .replace('message', '').trim() || 'text';
    if (['conversation', 'extendedtext', ''].includes(type)) type = 'text';
    if (type === 'media') type = (msg.mediaType || 'image').toLowerCase();

    // Mídia: URL fica em content.URL (maiúsculo) no Uazapi GO
    const content  = msg.content || {};
    const mediaUrl = content.URL || content.url || null;
    const mimeType = content.mimetype || content.mimeType || null;

    return {
      phone,
      body:     String(msg.text || content.caption || ''),
      type,
      mediaUrl,
      mimeType,
      isFromMe: msg.fromMe === true,
      msgId:    msg.messageid || msg.id || '',
    };
  }

  // ── Formato plano { phone/number, body/text, type } ───────────────────────
  if (raw.phone || raw.number) {
    return {
      phone:    raw.phone || raw.number,
      body:     String(raw.body || raw.text || raw.message || ''),
      type:     raw.type || 'text',
      mediaUrl: raw.mediaUrl || null,
      mimeType: raw.mimeType || null,
      isFromMe: raw.isFromMe === true || raw.fromMe === true,
      msgId:    raw.id || '',
    };
  }

  return null;
}

function setupWebhook(app) {
  async function processarWebhook(req, res) {
    const secret = getWebhookSecret();
    // Só valida o segredo se WEBHOOK_PATH_SECRET estiver configurado
    if (isSecretConfigured(secret) && !isValidSecret(req.params.secret, secret)) {
      logger.warn('[webhook] Tentativa com segredo inválido');
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    try {
      const raw    = req.body;
      const parsed = parsePayload(raw);

      if (!parsed) {
        logger.warn('[webhook] Formato não reconhecido');
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      const { phone, body, type, mediaUrl, mimeType, isFromMe, msgId } = parsed;

      logger.info(`[webhook] phone=${phone} type=${type} fromMe=${isFromMe} body="${(body||'').slice(0,60)}"`);

      if (isFromMe || !phone || (phone+'').includes('@g.us')) {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      // Anti-loop: ignora mensagens do número do agente
      const phoneDigits = (phone+'').replace(/\D/g, '');
      const agentDigits = (AGENT_PHONE+'').replace(/\D/g, '');
      if (phoneDigits === agentDigits || phoneDigits.endsWith(agentDigits)) {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      const dedupKey = messageKey(msgId);
      if (!(await claimWebhookMessage(dedupKey))) {
        logger.info(`[webhook] Duplicata ignorada: ${msgId}`);
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // A Uazapi só recebe sucesso depois que a mensagem foi reservada no
      // Firestore. O processamento continua após a confirmação HTTP.
      res.status(200).json({ ok: true });

      try {
        await handleMessage(phone, type, body, mediaUrl, mimeType);
        await completeWebhookMessage(dedupKey);
      } catch (err) {
        await releaseWebhookMessage(dedupKey, err.message);
        throw err;
      }
    } catch (err) {
      logger.error('[webhook] Erro:', err.message, err.stack?.slice(0, 300));
      if (!res.headersSent) {
        res.status(503).json({ ok: false, error: 'temporary_failure' });
      }
    }
  }

  app.post('/webhook', processarWebhook);
  app.post('/webhook/:secret', processarWebhook);

  app.get('/health', (_req, res) => res.json({
    ok: true,
    webhookProtected: isSecretConfigured(),
    ts: new Date().toISOString(),
  }));
}

module.exports = {
  setupWebhook,
  getWebhookSecret,
  isSecretConfigured,
  isValidSecret,
  parsePayload,
  messageKey,
};
