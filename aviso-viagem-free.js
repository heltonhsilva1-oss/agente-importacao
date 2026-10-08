'use strict';
// Aviso individual de "viagem iniciada" para clientes FREE.
//
// Controle idempotente por cliente + viagem em `avisos_viagem_free`. Reiniciar
// o servidor ou repetir a operação nunca duplica a mensagem; a falha de um
// cliente não interrompe os demais e fica registrada para nova tentativa.

const { getTipoCliente } = require('./tipo-cliente');
const { logger } = require('./logger');

const MAX_TENTATIVAS = 3;
const RESERVA_EXPIRA_MS = 10 * 60 * 1000;

function telefoneWhatsapp(cliente) {
  const d = String(cliente?.telefone || '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return d.startsWith('55') ? d : `55${d}`;
}

function mensagemViagemIniciada(nome) {
  return `Olá ${nome}! Uma nova viagem foi iniciada e você já pode enviar suas notas fiscais por aqui.`;
}

function chaveAviso(viagemId, clienteDocId) {
  return `${String(viagemId)}_${String(clienteDocId)}`;
}

// Reserva a tentativa de forma atômica. Retorna o número da tentativa ou null
// se o aviso já foi enviado / está em andamento / esgotou as tentativas.
async function reservarTentativa(db, ref, base, agora) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const atual = snap.exists ? snap.data() : null;
    if (atual) {
      if (atual.status === 'enviado') return null;
      if (atual.status === 'enviando' && agora - new Date(atual.reservado_em).getTime() < RESERVA_EXPIRA_MS) return null;
      if (Number(atual.tentativas || 0) >= MAX_TENTATIVAS) return null;
    }
    const tentativa = Number(atual?.tentativas || 0) + 1;
    tx.set(ref, {
      ...base, status: 'enviando', tentativas: tentativa,
      reservado_em: new Date(agora).toISOString(),
    }, { merge: true });
    return tentativa;
  });
}

// Envia o aviso a UM cliente Free. Nunca lança: devolve 'enviado' | 'falha' | 'ignorado'.
async function avisarClienteFree({ db, sendText, viagem, clienteDoc, agora = Date.now() }) {
  const cliente = clienteDoc.data();
  const phone = telefoneWhatsapp(cliente);
  if (!phone) return 'ignorado';
  const ref = db.collection('avisos_viagem_free').doc(chaveAviso(viagem.id, clienteDoc.id));
  const tentativa = await reservarTentativa(db, ref, {
    viagem_id: viagem.id, cliente_doc_id: clienteDoc.id, cliente_id: cliente.id ?? clienteDoc.id,
    cliente_nome: cliente.nome || '', telefone: phone,
  }, agora);
  if (tentativa == null) return 'ignorado';
  try {
    await sendText(phone, mensagemViagemIniciada(cliente.nome || ''), true);
    await ref.set({ status: 'enviado', enviado_em: new Date().toISOString(), ultimo_erro: null }, { merge: true });
    return 'enviado';
  } catch (error) {
    await ref.set({
      status: 'falha', ultima_tentativa_em: new Date().toISOString(),
      ultimo_erro: String(error?.message || error).slice(0, 300),
    }, { merge: true }).catch(() => {});
    logger.error(`[aviso-viagem-free] falha ao avisar ${cliente.nome}: ${error?.message || error}`);
    return 'falha';
  }
}

// Avisa todos os clientes Free ativos da viagem.
async function enviarAvisosViagemFree({ db, sendText, viagem, pausaMs = 0, agora = Date.now() }) {
  const resumo = { enviados: 0, falhas: 0, ignorados: 0 };
  const snap = await db.collection('clientes').get();
  for (const clienteDoc of snap.docs) {
    const c = clienteDoc.data();
    if (c.ativo === false || getTipoCliente(c) !== 'free') continue;
    const r = await avisarClienteFree({ db, sendText, viagem, clienteDoc, agora });
    if (r === 'enviado') resumo.enviados += 1;
    else if (r === 'falha') resumo.falhas += 1;
    else resumo.ignorados += 1;
    if (pausaMs && r === 'enviado') await new Promise(res => setTimeout(res, pausaMs));
  }
  logger.info(`[aviso-viagem-free] viagem ${viagem.id}: ${resumo.enviados} enviados, ${resumo.falhas} falhas, ${resumo.ignorados} ignorados`);
  return resumo;
}

// Reprocessa só os avisos que já falharam (nunca cria avisos novos), para
// viagens ainda em andamento.
async function reenviarFalhasViagemFree({ db, sendText, agora = Date.now() }) {
  const resumo = { enviados: 0, falhas: 0, ignorados: 0 };
  const falhas = await db.collection('avisos_viagem_free').where('status', '==', 'falha').get();
  for (const aviso of falhas.docs) {
    const a = aviso.data();
    if (Number(a.tentativas || 0) >= MAX_TENTATIVAS) continue;
    const viagemSnap = await db.collection('viagens').doc(String(a.viagem_id)).get();
    if (!viagemSnap.exists || viagemSnap.data().status !== 'em_andamento') continue;
    const clienteDoc = await db.collection('clientes').doc(String(a.cliente_doc_id)).get();
    if (!clienteDoc.exists || clienteDoc.data().ativo === false || getTipoCliente(clienteDoc.data()) !== 'free') continue;
    const r = await avisarClienteFree({ db, sendText, viagem: viagemSnap.data(), clienteDoc, agora });
    if (r === 'enviado') resumo.enviados += 1;
    else if (r === 'falha') resumo.falhas += 1;
    else resumo.ignorados += 1;
  }
  return resumo;
}

module.exports = {
  reenviarFalhasViagemFree, MAX_TENTATIVAS, telefoneWhatsapp, mensagemViagemIniciada, chaveAviso,
  reservarTentativa, avisarClienteFree, enviarAvisosViagemFree,
};
