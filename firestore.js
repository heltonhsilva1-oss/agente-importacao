'use strict';
// Funções auxiliares de acesso ao Firestore
// Todas as queries do agente passam por aqui

const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { getCobrancaPendente, getStatusPagamento } = require('./pagamentos');

const db = () => getFirestore();

// ── deduplicação persistente do webhook ──────────────────────────────────────

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?.seconds === 'number') return value.seconds * 1000;
  return 0;
}

async function claimWebhookMessage(messageKey) {
  if (!messageKey) return true;
  const ref = db().collection('webhook_processed').doc(messageKey);

  return db().runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.exists ? snap.data() : null;
    const processingExpired =
      data?.status === 'processando' &&
      timestampMillis(data.processando_em) < Date.now() - 5 * 60 * 1000;

    if (data?.status === 'concluido' || (data?.status === 'processando' && !processingExpired)) {
      return false;
    }

    transaction.set(ref, {
      status: 'processando',
      processando_em: Timestamp.now(),
      expira_em: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }, { merge: true });
    return true;
  });
}

async function completeWebhookMessage(messageKey) {
  if (!messageKey) return;
  await db().collection('webhook_processed').doc(messageKey).set({
    status: 'concluido',
    concluido_em: Timestamp.now(),
    processando_em: FieldValue.delete(),
    expira_em: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
  }, { merge: true });
}

async function releaseWebhookMessage(messageKey, error) {
  if (!messageKey) return;
  await db().collection('webhook_processed').doc(messageKey).delete();
  logger.warn(`[firestore] Reserva do webhook liberada após erro: ${String(error || '')}`);
}

// ── conversas ─────────────────────────────────────────────────────────────────
// Cada documento usa o número de telefone como ID
// estado: 'idle' | 'menu' | 'flow1_loja' | 'flow1_vendedor' | 'flow1_arquivo'
//       | 'flow2_cpf' | 'flow2_digitos' | 'flow2_selecao'
//       | 'flow3_cpf' | 'flow3_digitos'
//       | 'flow4_comprovante' | 'flow4_etiqueta'

async function getConversa(phone) {
  const snap = await db().collection('conversas').doc(phone).get();
  return snap.exists ? snap.data() : null;
}

async function setConversa(phone, data) {
  await db()
    .collection('conversas')
    .doc(phone)
    .set({ ...data, ultima_atividade: Timestamp.now() });
}

async function updateConversa(phone, data) {
  await db()
    .collection('conversas')
    .doc(phone)
    .set({ ...data, ultima_atividade: Timestamp.now() }, { merge: true });
}

async function clearConversa(phone) {
  await db().collection('conversas').doc(phone).set({
    estado: 'idle',
    dados: {},
    ultima_atividade: Timestamp.now(),
  });
}

// ── clientes ──────────────────────────────────────────────────────────────────

function normCpf(s) {
  return (s || '').replace(/\D/g, '');
}

function normPhone(s) {
  return (s || '').replace(/\D/g, '');
}

// Autentica cliente por CPF + 4 últimos dígitos do telefone
async function findClienteByCpfDigitos(cpf, ultimosDigitos) {
  const cpfLimpo = normCpf(cpf);
  const snap = await db().collection('clientes').get();
  for (const doc of snap.docs) {
    const c = doc.data();
    if (normCpf(c.cpf) === cpfLimpo) {
      const tel = normPhone(c.telefone);
      if (tel.slice(-4) === ultimosDigitos) return c;
    }
  }
  return null;
}

// Tenta encontrar cliente pelo número WhatsApp (útil no flow 4)
// Trata divergência do nono dígito: WhatsApp pode enviar com ou sem o 9 extra
async function findClienteByWhatsapp(whatsappPhone) {
  const digits = normPhone(whatsappPhone);
  const sem55 = digits.startsWith('55') ? digits.slice(2) : digits;

  // Gera variante do nono dígito para cobrir cadastros antigos/novos
  // sem55 com 10 dígitos (DDD+8) → tenta também DDD+"9"+8 (11 dígitos)
  // sem55 com 11 dígitos (DDD+9) → tenta também DDD+8 (10 dígitos, sem o 9)
  let sem55Alt = null;
  if (sem55.length === 10) {
    sem55Alt = sem55.slice(0, 2) + '9' + sem55.slice(2); // insere 9 após DDD
  } else if (sem55.length === 11 && sem55[2] === '9') {
    sem55Alt = sem55.slice(0, 2) + sem55.slice(3); // remove o 9 após DDD
  }

  const snap = await db().collection('clientes').get();
  for (const doc of snap.docs) {
    const cliente = doc.data();
    if (cliente.ativo === false) continue;
    const tel = normPhone(cliente.telefone);
    if (tel === sem55 || tel === digits) return cliente;
    if (sem55Alt && (tel === sem55Alt || tel === '55' + sem55Alt)) return cliente;
  }
  return null;
}

// ── pedidos ───────────────────────────────────────────────────────────────────

const STATUS_ATIVOS = [
  'nota_recebida',
  'retirado_paraguai',
  'aguardando_pgto_travessia',
  'em_transito',
  'chegou_sp',
  'aguardando_pgto_comissao',
  'aguardando_etiqueta',
  'aguardando_envio',
];

async function getPedidosAtivos(clienteId) {
  const snap = await db().collection('pedidos').get();
  return snap.docs
    .map((d) => d.data())
    .filter((p) => String(p.cliente_id) === String(clienteId) && STATUS_ATIVOS.includes(p.status));
}

async function getPedidosPendentes(clienteId) {
  const snap = await db().collection('pedidos').get();
  return snap.docs
    .map((d) => d.data())
    .filter(
      (p) =>
        String(p.cliente_id) === String(clienteId) &&
        getCobrancaPendente(p)
    );
}

async function updatePedidoStatus(pedidoId, novoStatus) {
  const snap = await db()
    .collection('pedidos')
    .where('id', '==', Number(pedidoId))
    .limit(1)
    .get();

  if (snap.empty) {
    logger.warn(`[firestore] Pedido ${pedidoId} não encontrado`);
    return;
  }

  const now = new Date();
  const entry = {
    status: novoStatus,
    data: now.toLocaleDateString('pt-BR'),
    hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  };

  await snap.docs[0].ref.update({
    status: novoStatus,
    historico_status: FieldValue.arrayUnion(entry),
  });
  logger.info(`[firestore] Pedido ${pedidoId} → ${novoStatus}`);
}

async function confirmarPagamentoPedido(pedidoId, tipo) {
  const snap = await db()
    .collection('pedidos')
    .where('id', '==', Number(pedidoId))
    .limit(1)
    .get();

  if (snap.empty) {
    logger.warn(`[firestore] Pedido ${pedidoId} não encontrado para confirmar pagamento`);
    return { ok: false, motivo: 'pedido_nao_encontrado' };
  }

  const pedido = snap.docs[0].data();
  if (getStatusPagamento(pedido, tipo) === 'pago') {
    logger.info(`[firestore] Pedido ${pedidoId}: pagamento de ${tipo} já estava confirmado`);
    return { ok: true, jaConfirmado: true, novoStatus: pedido.status };
  }

  const cobranca = getCobrancaPendente(pedido);
  if (!cobranca || cobranca.tipo !== tipo) {
    logger.warn(`[firestore] Pedido ${pedidoId} não aguarda pagamento de ${tipo}`);
    return { ok: false, motivo: 'pagamento_nao_pendente' };
  }

  const now = new Date();
  const entry = {
    status: cobranca.proximoStatus,
    data: now.toLocaleDateString('pt-BR'),
    hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  };

  await snap.docs[0].ref.update({
    [cobranca.campoPagamento]: 'pago',
    status_pagamento: getStatusPagamento(
      pedido,
      tipo === 'travessia' ? 'comissao' : 'travessia'
    ) === 'pago' ? 'pago' : 'pendente',
    status: cobranca.proximoStatus,
    historico_status: FieldValue.arrayUnion(entry),
  });

  logger.info(
    `[firestore] Pedido ${pedidoId}: pagamento de ${tipo} confirmado → ${cobranca.proximoStatus}`
  );
  return { ok: true, novoStatus: cobranca.proximoStatus };
}

// ── configurações ─────────────────────────────────────────────────────────────

async function getConfiguracoes() {
  const snap = await db().collection('configuracoes').doc('global').get();
  return snap.exists ? snap.data() : {};
}

// Viagem com o maior id = criada por último (ids são sequenciais, ver nextId no frontend).
// Usada para saber se a viagem atual foi aberta depois do último corte configurado.
async function getViagemMaisRecente() {
  const snap = await db().collection('viagens').get();
  let latest = null;
  snap.forEach(doc => {
    const v = doc.data();
    if (!latest || Number(v.id) > Number(latest.id)) latest = v;
  });
  return latest;
}

// ── pendentes de pagamento ────────────────────────────────────────────────────
// Cada documento aguardando compõe a fila de confirmação do operador.

async function addPendentePagamento(clienteNumero, clienteNome, pedidoId, tipo, valor) {
  if (!pedidoId || !Number.isFinite(Number(pedidoId))) {
    logger.error(`[firestore] addPendentePagamento: pedidoId inválido (${pedidoId}), abortando`);
    return { id: null, criado: false };
  }
  const ativos = await db()
    .collection('pendentes_pagamento')
    .where('status', 'in', ['aguardando', 'processando'])
    .get();
  const duplicado = ativos.docs.find((doc) => {
    const data = doc.data();
    return Number(data.pedido_id) === Number(pedidoId) && data.tipo === tipo;
  });
  if (duplicado) return { id: duplicado.id, criado: false };

  const ref = await db().collection('pendentes_pagamento').add({
    cliente_numero: clienteNumero,
    cliente_nome: clienteNome,
    pedido_id: Number(pedidoId),
    tipo,
    valor: Number(valor) || 0,
    status: 'aguardando',
    criado_em: Timestamp.now(),
  });
  return { id: ref.id, criado: true };
}

async function getPendentesPagamento() {
  const snap = await db()
    .collection('pendentes_pagamento')
    .where('status', 'in', ['aguardando', 'processando'])
    .get();

  const limiteProcessamento = Date.now() - 5 * 60 * 1000;
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((p) =>
      p.status === 'aguardando' ||
      (p.status === 'processando' && timestampMillis(p.processando_em) < limiteProcessamento)
    )
    .sort((a, b) => timestampMillis(a.criado_em) - timestampMillis(b.criado_em));
}

async function reservarPendente(id) {
  const ref = db().collection('pendentes_pagamento').doc(id);
  return db().runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return null;

    const data = snap.data();
    const processamentoExpirado =
      data.status === 'processando' &&
      timestampMillis(data.processando_em) < Date.now() - 5 * 60 * 1000;
    if (data.status !== 'aguardando' && !processamentoExpirado) return null;

    transaction.update(ref, {
      status: 'processando',
      processando_em: Timestamp.now(),
    });
    return { id: snap.id, ...data };
  });
}

async function finalizarPendente(id, status, erro = null) {
  const dados = {
    status,
    resolvido_em: Timestamp.now(),
    processando_em: FieldValue.delete(),
  };
  if (erro) dados.erro = String(erro).slice(0, 500);

  await db()
    .collection('pendentes_pagamento')
    .doc(id)
    .update(dados);
}

async function devolverPendenteFila(id, erro) {
  await db()
    .collection('pendentes_pagamento')
    .doc(id)
    .update({
      status: 'aguardando',
      processando_em: FieldValue.delete(),
      ultimo_erro: String(erro || 'Falha ao processar').slice(0, 500),
    });
}

// ── mensagens agendadas ───────────────────────────────────────────────────────

async function getMensagensProcessaveis() {
  const snap = await db()
    .collection('mensagens_agendadas')
    .where('status', 'in', ['pendente', 'processando'])
    .get();

  const processingLimit = Date.now() - 15 * 60 * 1000;
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((message) =>
      message.status === 'pendente' ||
      (message.status === 'processando' &&
        timestampMillis(message.processando_em) < processingLimit)
    )
    .sort((a, b) => timestampMillis(a.criado_em) - timestampMillis(b.criado_em));
}

async function claimScheduledMessage(id) {
  const ref = db().collection('mensagens_agendadas').doc(id);
  return db().runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return null;

    const data = snap.data();
    const processingExpired =
      data.status === 'processando' &&
      timestampMillis(data.processando_em) < Date.now() - 15 * 60 * 1000;
    if (data.status !== 'pendente' && !processingExpired) return null;

    transaction.update(ref, {
      status: 'processando',
      processando_em: Timestamp.now(),
    });
    return { id: snap.id, ...data };
  });
}

async function completeScheduledMessage(id) {
  await db().collection('mensagens_agendadas').doc(id).update({
    status: 'enviado',
    enviado_em: Timestamp.now(),
    processando_em: FieldValue.delete(),
    ultimo_erro: FieldValue.delete(),
  });
}

function getQueueFailureState(previousAttempts, maxAttempts = 5) {
  const attempts = Number(previousAttempts || 0) + 1;
  return { attempts, permanent: attempts >= maxAttempts };
}

async function failScheduledMessage(id, previousAttempts, error, maxAttempts = 5) {
  const { attempts, permanent } = getQueueFailureState(previousAttempts, maxAttempts);
  await db().collection('mensagens_agendadas').doc(id).update({
    status: permanent ? 'falha_permanente' : 'pendente',
    tentativas: attempts,
    ultimo_erro: String(error || 'Falha desconhecida').slice(0, 500),
    ultima_tentativa_em: Timestamp.now(),
    processando_em: FieldValue.delete(),
  });
  return { attempts, permanent };
}

// ── histórico de conversa ─────────────────────────────────────────────────────

async function appendHistorico(phone, role, content) {
  if (!phone || !content) return;
  try {
    const conv = await getConversa(phone) || {};
    const hist = (conv.historico || []).slice(-9);
    hist.push({ role, content: String(content).slice(0, 500) });
    await db().collection('conversas').doc(phone).set({ historico: hist }, { merge: true });
  } catch (_) {}
}

async function getHistorico(phone) {
  const conv = await getConversa(phone);
  return conv?.historico || [];
}

// ── clientes (todos ativos) ───────────────────────────────────────────────────

async function getClientesAtivos() {
  const snap = await db().collection('clientes').get();
  return snap.docs.map(d => d.data()).filter(c => c.ativo !== false);
}

async function criarRascunhoPedido(dados) {
  const ref = await db().collection('rascunhos_pedidos').add({
    ...dados,
    status: 'pendente',
    criado_em: Timestamp.now(),
  });
  return ref.id;
}

async function atualizarRascunho(docId, dados) {
  await db().collection('rascunhos_pedidos').doc(docId).update(dados);
}

module.exports = {
  claimWebhookMessage,
  completeWebhookMessage,
  releaseWebhookMessage,
  getConversa,
  setConversa,
  updateConversa,
  clearConversa,
  findClienteByCpfDigitos,
  findClienteByWhatsapp,
  getPedidosAtivos,
  getPedidosPendentes,
  updatePedidoStatus,
  confirmarPagamentoPedido,
  getConfiguracoes,
  getViagemMaisRecente,
  addPendentePagamento,
  getPendentesPagamento,
  reservarPendente,
  finalizarPendente,
  devolverPendenteFila,
  getMensagensProcessaveis,
  claimScheduledMessage,
  completeScheduledMessage,
  getQueueFailureState,
  failScheduledMessage,
  appendHistorico,
  getHistorico,
  getClientesAtivos,
  criarRascunhoPedido,
  atualizarRascunho,
};
