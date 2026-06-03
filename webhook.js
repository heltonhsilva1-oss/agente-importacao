'use strict';
// Rota Express que recebe webhooks da Uazapi

const { logger } = require('./logger');
const { handleMessage } = require('./menu');

const AGENT_PHONE = process.env.AGENT_PHONE || '5511961482602';

// Deduplicação: evita processar a mesma mensagem duas vezes (Uazapi envia webhook duplo)
const processedIds = new Map();
function isDuplicate(id) {
  if (!id) return false;
  if (processedIds.has(id)) return true;
  processedIds.set(id, Date.now());
  const cutoff = Date.now() - 30000;
  for (const [k, v] of processedIds) if (v < cutoff) processedIds.delete(k);
  return false;
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
  app.post('/webhook', async (req, res) => {
    res.status(200).json({ ok: true });

    try {
      const raw    = req.body;
      const parsed = parsePayload(raw);

      if (!parsed) {
        logger.warn('[webhook] Formato não reconhecido');
        return;
      }

      const { phone, body, type, mediaUrl, mimeType, isFromMe, msgId } = parsed;

      // Valida que a mensagem pertence à nossa instância
      const owner = (raw.message?.owner || raw.owner || '').replace(/\D/g, '');
      const agentNum = (AGENT_PHONE || '').replace(/\D/g, '');
      if (owner && owner !== agentNum) {
        logger.warn(`[webhook] Mensagem de instância desconhecida ignorada (owner: ${owner})`);
        return;
      }

      logger.info(`[webhook] phone=${phone} type=${type} fromMe=${isFromMe} body="${(body||'').slice(0,60)}"`);

      if (isFromMe)                       return; // mensagem do próprio agente
      if (!phone)                         return;
      if ((phone+'').includes('@g.us'))   return; // grupo

      // Anti-loop: ignora mensagens do número do agente
      const phoneDigits = (phone+'').replace(/\D/g, '');
      const agentDigits = (AGENT_PHONE+'').replace(/\D/g, '');
      if (phoneDigits === agentDigits || phoneDigits.endsWith(agentDigits)) return;

      // Deduplicação: ignora webhook duplicado da Uazapi
      if (isDuplicate(msgId)) {
        logger.info(`[webhook] Duplicata ignorada: ${msgId}`);
        return;
      }

      await handleMessage(phone, type, body, mediaUrl, mimeType);
    } catch (err) {
      logger.error('[webhook] Erro:', err.message, err.stack?.slice(0, 300));
    }
  });

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
}

module.exports = { setupWebhook };
