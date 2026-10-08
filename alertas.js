'use strict';
// Avisa o operador no WhatsApp quando uma rotina do agente falha, sem
// repetir o mesmo aviso a cada tentativa (no máximo 1 por rotina a cada 6 h).

const { logger } = require('./logger');

const OPERATOR_PHONE = () => process.env.OPERATOR_PHONE || '5511995715042';
const INTERVALO_MS = 6 * 60 * 60 * 1000;
const ultimoAviso = new Map();

function resumirErro(erro) {
  const texto = String(erro?.message || erro || 'erro desconhecido').replace(/\s+/g, ' ').trim();
  return texto.length > 200 ? `${texto.slice(0, 200)}…` : texto;
}

// `enviar(phone, texto, forcar)` é injetável para teste; o padrão é o sendText real.
async function alertarFalha(rotina, erro, { enviar, agora = Date.now() } = {}) {
  logger.error(`[alerta] ${rotina} falhou: ${resumirErro(erro)}`);
  const anterior = ultimoAviso.get(rotina);
  if (anterior && agora - anterior < INTERVALO_MS) return false;
  ultimoAviso.set(rotina, agora);
  try {
    const envio = enviar || require('./uazapi').sendText;
    await envio(OPERATOR_PHONE(), `⚠️ O agente teve uma falha na rotina "${rotina}".\n${resumirErro(erro)}\nVerifique o Railway se isto se repetir.`, true);
    return true;
  } catch (falhaDoAviso) {
    // Se nem o aviso sai (ex.: WhatsApp fora), só registra — nunca derruba o agente.
    logger.error(`[alerta] não foi possível avisar o operador: ${resumirErro(falhaDoAviso)}`);
    return false;
  }
}

// Envolve uma rotina: a falha é registrada, avisada e NÃO propaga.
function protegerRotina(nome, fn, opcoes) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (erro) {
      await alertarFalha(nome, erro, opcoes);
      return undefined;
    }
  };
}

function limparAvisos() { ultimoAviso.clear(); }

module.exports = { alertarFalha, protegerRotina, limparAvisos, resumirErro };
