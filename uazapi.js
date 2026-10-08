'use strict';
// Funções de envio de mensagens via Uazapi
// Endpoints descobertos: POST /send/text  POST /send/image  POST /send/document

const axios = require('axios');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { logger } = require('./logger');

function baseUrl() {
  return (process.env.UAZAPI_SERVER_URL || '').replace(/\/$/, '');
}

function headers() {
  return {
    token: process.env.UAZAPI_INSTANCE_TOKEN,
    'Content-Type': 'application/json',
  };
}

// Verifica se está dentro do horário comercial (8h–20h, Brasília)
function isHoraComercial() {
  const hora = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hour12: false,
  });
  const h = parseInt(hora);
  return h >= 8 && h < 20;
}

// Guarda mensagem na fila para envio às 8h
async function queueMensagem(phone, data) {
  const db = getFirestore();
  await db.collection('mensagens_agendadas').add({
    phone,
    ...data,
    criado_em: Timestamp.now(),
    status: 'pendente',
    tentativas: 0,
  });
}

// Envia mensagem de texto
// forceNow=true ignora horário comercial (respostas interativas ao cliente)
async function sendText(phone, message, forceNow = false) {
  const url = baseUrl();
  if (!url) { logger.error('[uazapi] UAZAPI_SERVER_URL não configurado!'); return; }
  if (!forceNow && !isHoraComercial()) {
    await queueMensagem(phone, { tipo: 'text', mensagem: message });
    logger.info(`[uazapi] Texto enfileirado para ${phone} (fora do horário)`);
    return;
  }
  try {
    await axios.post(
      `${url}/send/text`,
      { number: phone, text: message },
      { headers: headers(), timeout: 15000 }
    );
    logger.info(`[uazapi] Texto enviado → ${phone}`);
  } catch (err) {
    logger.error(`[uazapi] Erro ao enviar texto para ${phone}:`, err.response?.data || err.message);
    throw err;
  }
}

// Envia mídia (imagem ou documento PDF) via URL
async function sendMedia(phone, mediaUrl, mimeType, caption = '', forceNow = false) {
  const url = baseUrl();
  if (!url) { logger.error('[uazapi] UAZAPI_SERVER_URL não configurado!'); return; }
  if (!forceNow && !isHoraComercial()) {
    await queueMensagem(phone, { tipo: 'media', mediaUrl, mimeType, caption });
    logger.info(`[uazapi] Mídia enfileirada para ${phone} (fora do horário)`);
    return;
  }
  try {
    const isPdf =
      mimeType &&
      (mimeType.includes('pdf') ||
        mimeType.includes('document') ||
        mimeType.includes('octet-stream'));

    if (isPdf) {
      await axios.post(
        `${url}/send/document`,
        { number: phone, document: mediaUrl, filename: 'documento.pdf', caption },
        { headers: headers(), timeout: 20000 }
      );
    } else {
      await axios.post(
        `${url}/send/image`,
        { number: phone, image: mediaUrl, caption },
        { headers: headers(), timeout: 20000 }
      );
    }
    logger.info(`[uazapi] Mídia enviada → ${phone}`);
  } catch (err) {
    logger.error(`[uazapi] Erro ao enviar mídia para ${phone}:`, err.response?.data || err.message);
    throw err;
  }
}

// Gerencia participantes do grupo VIP. O número conectado precisa ser
// administrador do grupo na própria conta do WhatsApp.
async function updateGroupParticipants(groupJid, action, participants) {
  const url = baseUrl();
  if (!url) throw new Error('UAZAPI_SERVER_URL não configurado');
  const allowed = ['add', 'remove', 'promote', 'demote', 'approve', 'reject'];
  if (!allowed.includes(action)) throw new Error('Ação de grupo inválida');
  const group = String(groupJid || '').trim();
  if (!group.endsWith('@g.us')) throw new Error('VIP_GROUP_JID inválido');
  const numbers = [...new Set((participants || []).map(p => String(p).replace(/\D/g, '')).filter(Boolean))];
  if (!numbers.length) throw new Error('Nenhum participante informado');

  try {
    const response = await axios.post(
      `${url}/group/updateParticipants`,
      { groupjid: group, action, participants: numbers },
      { headers: headers(), timeout: 20000 }
    );
    logger.info(`[uazapi] Grupo ${action}: ${numbers.join(', ')}`);
    return response.data;
  } catch (err) {
    logger.error(`[uazapi] Erro ao atualizar grupo (${action}):`, err.response?.data || err.message);
    throw err;
  }
}

// Lista os participantes de um grupo (somente leitura — não altera o grupo).
async function getGroupParticipants(groupJid) {
  const url = baseUrl();
  if (!url) throw new Error('UAZAPI_SERVER_URL não configurado');
  const group = String(groupJid || '').trim();
  if (!group.endsWith('@g.us')) throw new Error('VIP_GROUP_JID inválido');
  try {
    const response = await axios.post(
      `${url}/group/info`,
      { groupjid: group, getInviteLink: false, getRequestsParticipants: false, force: true },
      { headers: headers(), timeout: 30000 }
    );
    const data = response.data || {};
    const lista = data.Participants || data.participants || data.group?.Participants || [];
    return { nome: data.Name || data.name || data.Subject || '', participantes: Array.isArray(lista) ? lista : [] };
  } catch (err) {
    logger.error('[uazapi] Erro ao consultar participantes do grupo:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendText, sendMedia, updateGroupParticipants, getGroupParticipants, isHoraComercial };
