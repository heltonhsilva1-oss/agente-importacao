'use strict';
// Funções auxiliares de acesso ao Firestore
// Todas as queries do agente passam por aqui

const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { logger } = require('./logger');

const db = () => getFirestore();

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
async function findClienteByWhatsapp(whatsappPhone) {
  // whatsappPhone no formato 5511999999999
  const digits = normPhone(whatsappPhone);
  // Remove o código do país 55 e tenta os últimos 11 ou 10 dígitos
  const sem55 = digits.startsWith('55') ? digits.slice(2) : digits;
  const snap = await db().collection('clientes').get();
  for (const doc of snap.docs) {
    const tel = normPhone(doc.data().telefone);
    if (tel === sem55 || tel === digits) return doc.data();
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
        ['aguardando_pgto_travessia', 'aguardando_pgto_comissao'].includes(p.status)
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

// ── configurações ─────────────────────────────────────────────────────────────

async function getConfiguracoes() {
  const snap = await db().collection('configuracoes').doc('global').get();
  return snap.exists ? snap.data() : {};
}

// ── pendentes de pagamento ────────────────────────────────────────────────────
// Rastreia qual confirmação de pagamento o operador deve responder

async function addPendentePagamento(clienteNumero, clienteNome) {
  const ref = await db().collection('pendentes_pagamento').add({
    cliente_numero: clienteNumero,
    cliente_nome: clienteNome,
    status: 'aguardando',
    criado_em: Timestamp.now(),
  });
  return ref.id;
}

// Recupera o pendente atual a partir da conversa do operador
async function getPendenteAtual(operadorPhone) {
  const conv = await getConversa(operadorPhone);
  const id = conv?.dados?.pendente_id;
  if (!id) return null;

  const snap = await db().collection('pendentes_pagamento').doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.status !== 'aguardando') return null;
  return { id: snap.id, ...data };
}

async function resolverPendente(id, confirmado) {
  await db()
    .collection('pendentes_pagamento')
    .doc(id)
    .update({ status: confirmado ? 'confirmado' : 'recusado', resolvido_em: Timestamp.now() });
}

// ── mensagens agendadas ───────────────────────────────────────────────────────

async function getMensagensPendentes() {
  const snap = await db()
    .collection('mensagens_agendadas')
    .where('status', '==', 'pendente')
    .orderBy('criado_em', 'asc')
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function marcarMensagemEnviada(id) {
  await db().collection('mensagens_agendadas').doc(id).update({ status: 'enviado' });
}

module.exports = {
  getConversa,
  setConversa,
  updateConversa,
  clearConversa,
  findClienteByCpfDigitos,
  findClienteByWhatsapp,
  getPedidosAtivos,
  getPedidosPendentes,
  updatePedidoStatus,
  getConfiguracoes,
  addPendentePagamento,
  getPendenteAtual,
  resolverPendente,
  getMensagensPendentes,
  marcarMensagemEnviada,
};
