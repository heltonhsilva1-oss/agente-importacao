'use strict';
// Funções de envio de mensagens via Uazapi WhatsApp API
// Docs da Uazapi: ajuste os endpoints se sua versão usar paths diferentes

const axios = require('axios');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { logger } = require('./logger');

function baseUrl() {
  return process.env.UAZAPI_SERVER_URL;
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
  });
}

// Envia mensagem de texto
// forceNow=true ignora horário comercial (usado em respostas interativas)
async function sendText(phone, message, forceNow = false) {
  if (!forceNow && !isHoraComercial()) {
    await queueMensagem(phone, { tipo: 'text', mensagem: message });
    logger.info(`[uazapi] Texto enfileirado para ${phone} (fora do horário)`);
    return;
  }
  try {
    await axios.post(
      `${baseUrl()}/message/sendText`,
      { phone, message },
      { headers: headers(), timeout: 15000 }
    );
    logger.info(`[uazapi] Texto enviado → ${phone}`);
  } catch (err) {
    logger.error(`[uazapi] Erro ao enviar texto para ${phone}:`, err.message);
    throw err;
  }
}

// Envia mídia (imagem ou documento) via URL
// mimeType indica se é imagem ou documento PDF
async function sendMedia(phone, mediaUrl, mimeType, caption = '', forceNow = false) {
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
        `${baseUrl()}/message/sendDocument`,
        { phone, document: mediaUrl, fileName: 'documento.pdf', caption },
        { headers: headers(), timeout: 20000 }
      );
    } else {
      await axios.post(
        `${baseUrl()}/message/sendImage`,
        { phone, image: mediaUrl, caption },
        { headers: headers(), timeout: 20000 }
      );
    }
    logger.info(`[uazapi] Mídia enviada → ${phone} (${mimeType})`);
  } catch (err) {
    logger.error(`[uazapi] Erro ao enviar mídia para ${phone}:`, err.message);
    throw err;
  }
}

module.exports = { sendText, sendMedia, isHoraComercial };
