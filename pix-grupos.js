'use strict';

const crypto = require('crypto');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getCobrancaPendente, getStatusPagamento } = require('./pagamentos');

function selecionarGrupo(pedidos, ids, clienteId) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids.map(String)).size !== ids.length) {
    throw new Error('invalid_payment_group');
  }
  const itens = ids.map(id => pedidos.find(p => String(p.id) === String(id)));
  if (itens.some(p => !p || String(p.cliente_id) !== String(clienteId))) throw new Error('order_not_found');
  const primeiro = itens[0];
  const tipo = getCobrancaPendente(primeiro)?.tipo;
  if (primeiro.viagem_id == null || !tipo) throw new Error('no_pending_charge');
  const detalhes = itens.map(p => {
    const cobranca = getCobrancaPendente(p);
    if (String(p.viagem_id) !== String(primeiro.viagem_id) || cobranca?.tipo !== tipo || !Number.isFinite(cobranca.valor) || cobranca.valor < 0.01) {
      throw new Error('payment_group_changed');
    }
    return { pedido_id: Number(p.id), valor: Math.round(cobranca.valor * 100) / 100 };
  }).sort((a, b) => a.pedido_id - b.pedido_id);
  return { cliente_id: String(clienteId), viagem_id: String(primeiro.viagem_id), tipo,
    itens: detalhes, valor: detalhes.reduce((s, p) => s + Math.round(p.valor * 100), 0) / 100 };
}

async function reservarGrupo({ encontrados, ids, clienteId, email, db = getFirestore() }) {
  return db.runTransaction(async tx => {
    const snapshots = await Promise.all(encontrados.map(p => tx.get(p.ref)));
    const grupo = selecionarGrupo(snapshots.filter(s => s.exists).map(s => s.data()), ids, clienteId);
    const locks = grupo.itens.map(p => db.collection('cobrancas_pix').doc(`${p.pedido_id}_${grupo.tipo}`));
    const existentes = await Promise.all(locks.map(ref => tx.get(ref)));
    const vinculados = existentes.filter(s => s.exists && s.data().grupo_id);
    if (vinculados.length) {
      const grupos = [...new Set(vinculados.map(s => s.data().grupo_id))];
      const existente = await tx.get(db.collection('cobrancas_pix').doc(grupos[0]));
      if (grupos.length === 1 && existente.exists && existente.data().itens.length === grupo.itens.length
        && existente.data().itens.every(p => grupo.itens.some(i => i.pedido_id === p.pedido_id && i.valor === p.valor))) {
        return { existing: { ...existente.data(), charge_id: existente.id } };
      }
      throw new Error('active_payment_conflict');
    }
    if (existentes.some(s => s.exists && ['criando', 'pendente', 'pago', 'erro'].includes(s.data().status))) {
      throw new Error('active_payment_conflict');
    }
    const ref = db.collection('cobrancas_pix').doc(`grupo_${crypto.randomUUID().replaceAll('-', '')}`);
    const data = { ...grupo, charge_id: ref.id, email_pagador: email, tentativa: 1,
      idempotency_key: crypto.randomUUID(), status: 'criando', criado_em: Timestamp.now(), atualizado_em: Timestamp.now() };
    tx.set(ref, data);
    locks.forEach((lock, i) => tx.set(lock, { grupo_id: ref.id, cliente_id: grupo.cliente_id,
      pedido_id: grupo.itens[i].pedido_id, tipo: grupo.tipo, status: 'agrupada' }));
    return { ref, data };
  });
}

async function confirmarGrupo(chargeRef, db = getFirestore()) {
  return db.runTransaction(async tx => {
    const chargeSnap = await tx.get(chargeRef);
    const charge = chargeSnap.data();
    if (charge.status === 'pago') return { paid: true, duplicate: true };
    const encontrados = await Promise.all(charge.itens.map(item => tx.get(db.collection('pedidos').where('id', '==', item.pedido_id).limit(1))));
    const viagem = await tx.get(db.collection('viagens').doc(charge.viagem_id));
    const resultados = charge.itens.map((item, i) => {
      const snap = encontrados[i].docs[0];
      if (!snap) throw new Error('order_not_found');
      const pedido = snap.data();
      const cobranca = getCobrancaPendente(pedido);
      if (String(pedido.cliente_id) !== charge.cliente_id || String(pedido.viagem_id) !== charge.viagem_id
        || !cobranca || cobranca.tipo !== charge.tipo || Math.round(cobranca.valor * 100) !== Math.round(item.valor * 100)) {
        throw new Error(`payment_group_changed:${item.pedido_id}`);
      }
      const extras = {};
      let status = cobranca.proximoStatus;
      if (charge.tipo === 'travessia') {
        const percentual = Number(viagem.data()?.comissao_antecipada_percentual) || 0;
        const valor = Math.round((Number(pedido.total_comissao_brl) || 0) * percentual) / 100;
        if (percentual > 0 && valor >= 0.01 && getStatusPagamento(pedido, 'comissao_antecipada') !== 'pago') {
          status = 'aguardando_pgto_comissao_antecipada';
          Object.assign(extras, { comissao_antecipada_percentual: percentual, valor_comissao_antecipada_brl: valor, pagamento_comissao_antecipada: 'pendente' });
        }
      }
      return { ref: snap.ref, pedido, cobranca, status, extras, item };
    });
    const agora = new Date();
    const pagos = resultados.map(({ ref, pedido, cobranca, status, extras, item }) => {
      tx.update(ref, { [cobranca.campoPagamento]: 'pago', status,
        status_pagamento: getStatusPagamento(pedido, charge.tipo === 'comissao' ? 'travessia' : 'comissao') === 'pago' ? 'pago' : 'pendente',
        ...extras, [`pix_${charge.tipo}`]: { cobranca_id: chargeRef.id, valor: item.valor, provider_order_id: charge.provider_order_id },
        historico_status: FieldValue.arrayUnion({ status, data: agora.toLocaleDateString('pt-BR'), hora: agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }) });
      return { ...item, pedidoStatus: status, comissaoAntecipadaPercentual: extras.comissao_antecipada_percentual || null,
        valorComissaoAntecipada: extras.valor_comissao_antecipada_brl || null };
    });
    tx.update(chargeRef, { status: 'pago', itens: pagos, pago_em: Timestamp.now(), atualizado_em: Timestamp.now() });
    return { paid: true };
  });
}

async function encerrarGrupo(chargeRef, status) {
  const db = getFirestore();
  await db.runTransaction(async tx => {
    const snap = await tx.get(chargeRef);
    const charge = snap.data();
    if (charge.status === 'pago') return;
    const locks = await Promise.all(charge.itens.map(item => tx.get(db.collection('cobrancas_pix').doc(`${item.pedido_id}_${charge.tipo}`))));
    locks.forEach(lock => { if (lock.exists && lock.data().grupo_id === chargeRef.id) tx.delete(lock.ref); });
    tx.update(chargeRef, { status, atualizado_em: Timestamp.now() });
  });
}

module.exports = { selecionarGrupo, reservarGrupo, confirmarGrupo, encerrarGrupo };
