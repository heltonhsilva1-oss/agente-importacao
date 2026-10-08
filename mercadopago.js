'use strict';

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { getCobrancaPendente } = require('./pagamentos');
const { confirmarPagamentoPedido } = require('./firestore');
const { verifyPortalSession } = require('./portal-access');
const { allowOrigin, setCors } = require('./portal');
const { reservarGrupo, confirmarGrupo, encerrarGrupo } = require('./pix-grupos');
const { sendText } = require('./uazapi');
const { chaveDataSaoPaulo } = require('./mensalidade');
const { reincluirVipPago } = require('./tipo-cliente');

const API_BASE = 'https://api.mercadopago.com';
const CHARGE_TTL_MS = 24 * 60 * 60 * 1000;
const CREATING_TTL_MS = 60 * 1000;
const RECONCILIATION_INTERVAL_MS = 60 * 1000;
let reconciliationStarted = false;

function getAccessToken() {
  return String(process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
}

function getWebhookSecret() {
  return String(process.env.MERCADOPAGO_WEBHOOK_SECRET || '').trim();
}

function getWebhookPathSecret() {
  return String(process.env.MERCADOPAGO_WEBHOOK_PATH_SECRET || '').trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?.seconds === 'number') return value.seconds * 1000;
  return 0;
}

function publicCharge(data) {
  return {
    chargeId: data.charge_id || null,
    itens: data.itens || (data.pedido_id ? [{ pedido_id: data.pedido_id, valor: data.valor,
      pedidoStatus: data.pedido_status || null, comissaoAntecipadaPercentual: data.comissao_antecipada_percentual || null,
      valorComissaoAntecipada: data.valor_comissao_antecipada_brl || null }] : []),
    status: data.status,
    tipo: data.tipo,
    valor: data.valor,
    qrCode: data.qr_code || '',
    qrCodeBase64: data.qr_code_base64 || '',
    ticketUrl: data.ticket_url || '',
    expiresAt: timestampMillis(data.expira_em) || null,
    pedidoStatus: data.pedido_status || null,
    comissaoAntecipadaPercentual: data.comissao_antecipada_percentual || null,
    valorComissaoAntecipada: data.valor_comissao_antecipada_brl || null,
  };
}

function parseSignature(header) {
  return Object.fromEntries(
    String(header || '').split(',').map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
  );
}

function verifyWebhookSignature({ xSignature, xRequestId, dataId, secret = getWebhookSecret() }) {
  if (!xSignature || !xRequestId || !dataId || !secret) return false;
  const { ts, v1 } = parseSignature(xSignature);
  if (!ts || !v1) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const receivedBuffer = Buffer.from(v1);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function verifyWebhookPathSecret(received, expected = getWebhookPathSecret()) {
  if (!received || expected.length < 32) return false;
  const receivedBuffer = Buffer.from(String(received));
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

async function mercadoPagoRequest(method, path, data, { idempotencyKey } = {}) {
  const accessToken = getAccessToken();
  if (!accessToken) throw new Error('MERCADOPAGO_ACCESS_TOKEN nao configurado');
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (method === 'post') headers['X-Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
  const response = await axios({ method, url: `${API_BASE}${path}`, data, headers, timeout: 15000 });
  return response.data;
}

async function findPedido(pedidoId) {
  const numericId = Number(pedidoId);
  if (!Number.isFinite(numericId)) return null;
  const snap = await getFirestore().collection('pedidos').where('id', '==', numericId).limit(1).get();
  return snap.empty ? null : { ref: snap.docs[0].ref, data: snap.docs[0].data() };
}

function extractPix(order) {
  const payment = order?.transactions?.payments?.[0] || {};
  const method = payment.payment_method || {};
  return {
    providerOrderId: String(order?.id || ''),
    providerStatus: String(order?.status || ''),
    qrCode: method.qr_code || '',
    qrCodeBase64: method.qr_code_base64 || '',
    ticketUrl: method.ticket_url || '',
  };
}

function buildExternalReference(chargeId, attempt) {
  return `kidex_pix_${chargeId}_${attempt}`;
}

function parseExternalReference(value) {
  const reference = String(value || '');
  // Formato atual usa apenas caracteres aceitos pelo Mercado Pago.
  const current = /^kidex_pix_(.+)_(\d+)$/.exec(reference);
  if (current) return { chargeId: current[1], attempt: Number(current[2]) };

  // Compatibilidade com orders criadas antes da correção.
  const legacy = /^kidex_pix\|([^|]+)\|(\d+)$/.exec(reference);
  return legacy ? { chargeId: legacy[1], attempt: Number(legacy[2]) } : null;
}

function vipChargeId(clienteId, competencia = chaveDataSaoPaulo().slice(0, 7)) {
  const safeId = String(clienteId).replace(/[^A-Za-z0-9_-]/g, '_');
  return `vip_${safeId}_${competencia}`;
}

function vipPayerEmail(cliente) {
  const configured = String(cliente?.email || process.env.MERCADOPAGO_PAYER_EMAIL || '').trim().toLowerCase();
  if (isValidEmail(configured)) return configured;
  // A API de Orders exige um e-mail sintaticamente válido para o Pix. O
  // identificador técnico evita bloquear clientes cujo cadastro é só telefone.
  const safeId = String(cliente?.id || 'vip').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'vip';
  return `${safeId}@cliente.kidex.com.br`;
}

async function createVipPixCharge({ clienteDocId, cliente, valor, competencia = chaveDataSaoPaulo().slice(0, 7) }) {
  const amount = Number(valor);
  if (!Number.isFinite(amount) || amount < 0.01) throw new Error('vip_amount_invalid');
  const email = vipPayerEmail(cliente);
  const db = getFirestore();
  const chargeId = vipChargeId(clienteDocId, competencia);
  const ref = db.collection('cobrancas_pix').doc(chargeId);
  const existing = await ref.get();
  const current = existing.exists ? existing.data() : null;
  if (current?.status === 'pago') return publicCharge({ ...current, charge_id: chargeId });
  if (current?.status === 'pendente' && timestampMillis(current.expira_em) > Date.now() && current.qr_code) {
    return publicCharge({ ...current, charge_id: chargeId });
  }

  const attempt = Number(current?.tentativa || 0) + 1;
  const idempotencyKey = crypto.randomUUID();
  await ref.set({
    charge_id: chargeId,
    tipo: 'mensalidade_vip',
    cliente_doc_id: String(clienteDocId),
    cliente_id: String(cliente?.id ?? clienteDocId),
    cliente_nome: String(cliente?.nome || ''),
    cliente_phone: String(cliente?.telefone || '').replace(/\D/g, ''),
    competencia,
    valor: Number(amount.toFixed(2)),
    email_pagador: email,
    tentativa: attempt,
    idempotency_key: idempotencyKey,
    status: 'criando',
    criando_em: Timestamp.now(),
    atualizado_em: Timestamp.now(),
  }, { merge: true });

  const externalReference = buildExternalReference(chargeId, attempt);
  try {
    const orderPayload = {
      type: 'online', total_amount: amount.toFixed(2), external_reference: externalReference,
      processing_mode: 'automatic',
      transactions: { payments: [{ amount: amount.toFixed(2), payment_method: {
        id: 'pix', type: 'bank_transfer',
      }, expiration_time: 'P1D' }] },
    };
    orderPayload.payer = { email };
    const order = await mercadoPagoRequest('post', '/v1/orders', orderPayload, { idempotencyKey });
    const pix = extractPix(order);
    if (!pix.providerOrderId || (!pix.qrCode && !pix.ticketUrl)) throw new Error('Mercado Pago nao retornou dados do Pix');
    await ref.set({
      status: 'pendente', provider_status: pix.providerStatus, provider_order_id: pix.providerOrderId,
      external_reference: externalReference, qr_code: pix.qrCode, qr_code_base64: pix.qrCodeBase64,
      ticket_url: pix.ticketUrl, expira_em: Timestamp.fromMillis(Date.now() + CHARGE_TTL_MS),
      atualizado_em: Timestamp.now(), criando_em: FieldValue.delete(),
    }, { merge: true });
    if (pix.providerStatus === 'processed') await processOrderWebhook(pix.providerOrderId);
    return publicCharge({ ...(await ref.get()).data(), charge_id: chargeId });
  } catch (error) {
    await ref.set({ status: 'erro', ultimo_erro: String(error.response?.data?.message || error.message).slice(0, 400),
      atualizado_em: Timestamp.now(), criando_em: FieldValue.delete() }, { merge: true });
    throw error;
  }
}

async function reserveCharge({ pedido, cobranca, email }) {
  const db = getFirestore();
  const chargeId = `${pedido.id}_${cobranca.tipo}`;
  const ref = db.collection('cobrancas_pix').doc(chargeId);
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const current = snap.exists ? snap.data() : null;
    if (current?.grupo_id) {
      const grupo = await transaction.get(db.collection('cobrancas_pix').doc(current.grupo_id));
      if (!grupo.exists) throw new Error('payment_group_not_found');
      return { kind: 'existing', data: grupo.data() };
    }
    const expiresAt = timestampMillis(current?.expira_em);
    const creatingAt = timestampMillis(current?.criando_em);

    if (current?.status === 'pago') return { kind: 'existing', data: current };
    if (current?.status === 'pendente' && expiresAt > now && current.qr_code) {
      return { kind: 'existing', data: current };
    }
    if (current?.status === 'criando' && creatingAt > now - CREATING_TTL_MS) {
      return { kind: 'creating' };
    }

    const attempt = Number(current?.tentativa || 0) + 1;
    const idempotencyKey = crypto.randomUUID();
    transaction.set(ref, {
      pedido_id: Number(pedido.id),
      cliente_id: String(pedido.cliente_id),
      tipo: cobranca.tipo,
      valor: Number(cobranca.valor.toFixed(2)),
      email_pagador: email,
      tentativa: attempt,
      idempotency_key: idempotencyKey,
      status: 'criando',
      criando_em: Timestamp.now(),
      atualizado_em: Timestamp.now(),
      ultimo_erro: FieldValue.delete(),
    }, { merge: true });
    return { kind: 'reserved', ref, chargeId, attempt, idempotencyKey };
  });
}

async function createPixCharge({ pedido, cobranca, email, grupo }) {
  let reservation;
  if (grupo) {
    const reservado = await reservarGrupo({ ...grupo, email });
    const data = reservado.data || reservado.existing;
    if (reservado.existing && !['criando', 'erro'].includes(data.status)) return publicCharge(data);
    // Repetir uma requisição incerta usa a mesma chave: nunca gera outro Pix.
    reservation = { ref: reservado.ref || getFirestore().collection('cobrancas_pix').doc(data.charge_id),
      chargeId: data.charge_id, attempt: data.tentativa, idempotencyKey: data.idempotency_key };
    cobranca = data;
    email = data.email_pagador;
  } else reservation = await reserveCharge({ pedido, cobranca, email });
  if (reservation.kind === 'existing') return publicCharge(reservation.data);
  if (reservation.kind === 'creating') {
    const error = new Error('charge_being_created');
    error.status = 409;
    throw error;
  }

  const amount = Number(cobranca.valor).toFixed(2);
  const externalReference = buildExternalReference(reservation.chargeId, reservation.attempt);

  try {
    const order = await mercadoPagoRequest('post', '/v1/orders', {
      type: 'online',
      total_amount: amount,
      external_reference: externalReference,
      processing_mode: 'automatic',
      transactions: {
        payments: [{
          amount,
          payment_method: { id: 'pix', type: 'bank_transfer' },
          expiration_time: 'P1D',
        }],
      },
      payer: { email },
    }, { idempotencyKey: reservation.idempotencyKey });
    const pix = extractPix(order);
    if (!pix.providerOrderId || (!pix.qrCode && !pix.ticketUrl)) {
      throw new Error('Mercado Pago nao retornou dados do Pix');
    }

    const stored = {
      status: 'pendente',
      provider_status: pix.providerStatus,
      provider_order_id: pix.providerOrderId,
      external_reference: externalReference,
      qr_code: pix.qrCode,
      qr_code_base64: pix.qrCodeBase64,
      ticket_url: pix.ticketUrl,
      expira_em: Timestamp.fromMillis(Date.now() + CHARGE_TTL_MS),
      atualizado_em: Timestamp.now(),
      criando_em: FieldValue.delete(),
    };
    await getFirestore().runTransaction(async tx => {
      const snap = await tx.get(reservation.ref);
      if (snap.data()?.status === 'pago') return;
      tx.set(reservation.ref, stored, { merge: true });
    });
    if (pix.providerStatus === 'processed') await processOrderWebhook(pix.providerOrderId);
    return publicCharge({ ...(await reservation.ref.get()).data(), charge_id: reservation.chargeId });
  } catch (error) {
    await getFirestore().runTransaction(async tx => {
      const snap = await tx.get(reservation.ref);
      if (['pago', 'pendente'].includes(snap.data()?.status)) return;
      tx.set(reservation.ref, {
        status: 'erro',
        ultimo_erro: String(error.response?.data?.message || error.message).slice(0, 400),
        atualizado_em: Timestamp.now(),
        criando_em: FieldValue.delete(),
      }, { merge: true });
    });
    throw error;
  }
}

async function processOrderWebhook(orderId) {
  const order = await mercadoPagoRequest('get', `/v1/orders/${encodeURIComponent(orderId)}`);
  const externalReference = String(order?.external_reference || '');
  const reference = parseExternalReference(externalReference);
  if (!reference) return { ignored: true };

  const chargeRef = getFirestore().collection('cobrancas_pix').doc(reference.chargeId);
  const chargeSnap = await chargeRef.get();
  if (!chargeSnap.exists) return { ignored: true };
  const charge = chargeSnap.data();
  if (String(charge.provider_order_id) !== String(order.id)) return { ignored: true };

  const receivedAmount = Number(order.total_amount);
  if (!Number.isFinite(receivedAmount) || Math.abs(receivedAmount - Number(charge.valor)) > 0.001) {
    throw new Error('Valor da order diverge da cobranca');
  }

  await chargeRef.set({
    provider_status: String(order.status || ''),
    provider_status_detail: String(order.status_detail || ''),
    atualizado_em: Timestamp.now(),
  }, { merge: true });

  if (order.status !== 'processed' || order.status_detail !== 'accredited') {
    if (['canceled', 'expired'].includes(order.status) && charge.status !== 'pago') {
      if (charge.itens?.length) await encerrarGrupo(chargeRef, order.status);
      else await chargeRef.update({ status: order.status });
    }
    return { paid: false };
  }
  if (charge.status === 'pago') return { paid: true, duplicate: true };

  if (charge.tipo === 'mensalidade_vip') {
    const paidDate = chaveDataSaoPaulo();
    const clienteRef = getFirestore().collection('clientes').doc(String(charge.cliente_doc_id));
    const clienteAntes = await clienteRef.get();
    await getFirestore().runTransaction(async tx => {
      const freshCharge = await tx.get(chargeRef);
      if (freshCharge.data()?.status === 'pago') return;
      tx.set(chargeRef, { status: 'pago', pago_em: Timestamp.now(), atualizado_em: Timestamp.now() }, { merge: true });
      tx.set(clienteRef, {
        status_mensalidade: 'paga', data_pagamento_mensalidade: paidDate,
        mensalidade_competencia_paga: charge.competencia, mensalidade_charge_id: chargeRef.id,
        atualizado_em: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    const phone = String(charge.cliente_phone || '').replace(/\D/g, '');
    try {
      const { updateGroupParticipants } = require('./uazapi');
      await reincluirVipPago({
        db: getFirestore(), clienteRef, cliente: clienteAntes.data() || {}, phone,
        adicionarAoGrupo: updateGroupParticipants, extras: { reincluido_grupo_vip_em: Timestamp.now() },
      });
    } catch (error) {
      logger.error('[mercadopago] Pagamento confirmado, mas reinclusão no VIP falhou:', error.message);
      await sendText(process.env.OPERATOR_PHONE || '5511995715042',
        `Pagamento VIP de ${charge.cliente_nome} confirmado, mas a reinclusão no grupo falhou: ${error.message}`, true);
    }
    if (phone) await sendText(phone, `Pagamento da mensalidade VIP de *${charge.competencia}* confirmado automaticamente. Obrigado!`, true);
    return { paid: true, tipo: 'mensalidade_vip' };
  }

  if (Array.isArray(charge.itens) && charge.itens.length) return confirmarGrupo(chargeRef);

  const result = await confirmarPagamentoPedido(charge.pedido_id, charge.tipo);
  if (!result.ok) throw new Error(`Falha ao confirmar pedido: ${result.motivo}`);
  await chargeRef.set({
    status: 'pago',
    pedido_status: result.novoStatus || null,
    comissao_antecipada_percentual: result.comissaoAntecipadaPercentual || null,
    valor_comissao_antecipada_brl: result.valorComissaoAntecipada || null,
    pago_em: Timestamp.now(),
    atualizado_em: Timestamp.now(),
  }, { merge: true });
  return { paid: true };
}

async function refreshPendingCharge(chargeSnap, { processOrder = processOrderWebhook } = {}) {
  const charge = chargeSnap.data();
  if (charge.status !== 'pendente' || !charge.provider_order_id) return chargeSnap;

  try {
    await processOrder(charge.provider_order_id);
  } catch (error) {
    // A consulta do portal continua respondendo com o último estado salvo.
    // O próximo polling tenta novamente sem derrubar a tela do cliente.
    logger.warn('[mercadopago] Falha ao atualizar status da order:', JSON.stringify(
      error.response?.data || { message: error.message }
    ));
  }
  return chargeSnap.ref.get();
}

async function reconcilePendingPixCharges({ loadPending, processOrder = processOrderWebhook, now = Date.now() } = {}) {
  const charges = loadPending
    ? await loadPending()
    : (await getFirestore().collection('cobrancas_pix')
      .where('status', '==', 'pendente').limit(50).get()).docs.map(doc => doc.data());

  let checked = 0;
  let paid = 0;
  for (const charge of charges) {
    const expiresAt = timestampMillis(charge.expira_em);
    if (!charge.provider_order_id || (!charge.itens?.length && expiresAt && expiresAt <= now)) continue;
    checked += 1;
    try {
      const result = await processOrder(charge.provider_order_id);
      if (result?.paid) paid += 1;
    } catch (error) {
      logger.warn('[mercadopago] Falha na reconciliação Pix:', JSON.stringify(
        error.response?.data || { message: error.message }
      ));
    }
  }
  return { checked, paid };
}

function startPixReconciliation() {
  if (reconciliationStarted) return;
  reconciliationStarted = true;
  const run = async () => {
    const result = await reconcilePendingPixCharges();
    if (result.paid > 0) {
      logger.info(`[mercadopago] ${result.paid} pagamento(s) Pix reconciliado(s)`);
    }
  };
  const initialTimer = setTimeout(() => run().catch(error =>
    logger.error('[mercadopago] Erro ao iniciar reconciliação:', error.message)
  ), 5000);
  const interval = setInterval(() => run().catch(error =>
    logger.error('[mercadopago] Erro na reconciliação periódica:', error.message)
  ), RECONCILIATION_INTERVAL_MS);
  initialTimer.unref?.();
  interval.unref?.();
}

function setupMercadoPago(app) {
  const router = express.Router();

  router.options('/pix', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });
  router.options('/pix/status', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });

  router.post('/pix', async (req, res) => {
    setCors(req, res);
    if (req.headers.origin && !allowOrigin(req.headers.origin)) {
      res.status(403).json({ ok: false, error: 'origin_not_allowed' });
      return;
    }

    const session = verifyPortalSession(req.body?.sessionToken);
    if (!session) {
      res.status(401).json({ ok: false, error: 'invalid_session' });
      return;
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      res.status(400).json({ ok: false, error: 'invalid_email' });
      return;
    }

    try {
      const found = await findPedido(req.body?.pedidoId);
      if (!found || String(found.data.cliente_id) !== session.clienteId) {
        res.status(404).json({ ok: false, error: 'order_not_found' });
        return;
      }
      const cobranca = getCobrancaPendente(found.data);
      if (!cobranca || cobranca.valor < 0.01) {
        res.status(409).json({ ok: false, error: 'no_pending_charge' });
        return;
      }
      let grupo;
      if (Array.isArray(req.body?.pedidoIds)) {
        const ids = req.body.pedidoIds;
        if (!ids.length || ids.length > 100 || !ids.some(id => String(id) === String(found.data.id))) throw new Error('invalid_payment_group');
        const encontrados = await Promise.all(ids.map(findPedido));
        if (encontrados.some(p => !p || String(p.data.cliente_id) !== session.clienteId)) {
          res.status(404).json({ ok: false, error: 'order_not_found' });
          return;
        }
        grupo = { encontrados, ids, clienteId: session.clienteId };
      }
      const charge = await createPixCharge({ pedido: found.data, cobranca, email, grupo });
      res.json({ ok: true, charge });
    } catch (error) {
      logger.error('[mercadopago] Falha ao criar Pix:', JSON.stringify(error.response?.data || { message: error.message }));
      const conflito = ['active_payment_conflict', 'payment_group_changed', 'no_pending_charge'].includes(error.message);
      res.status(conflito ? 409 : error.status || 502).json({ ok: false, error: conflito ? error.message : 'pix_creation_failed' });
    }
  });

  router.post('/pix/status', async (req, res) => {
    setCors(req, res);
    if (req.headers.origin && !allowOrigin(req.headers.origin)) {
      res.status(403).json({ ok: false, error: 'origin_not_allowed' });
      return;
    }
    const session = verifyPortalSession(req.body?.sessionToken);
    if (!session) {
      res.status(401).json({ ok: false, error: 'invalid_session' });
      return;
    }
    const found = await findPedido(req.body?.pedidoId);
    if (!found || String(found.data.cliente_id) !== session.clienteId) {
      res.status(404).json({ ok: false, error: 'order_not_found' });
      return;
    }
    const tipo = String(req.body?.tipo || '');
    if (!['travessia', 'comissao_antecipada', 'comissao'].includes(tipo)) {
      res.status(400).json({ ok: false, error: 'invalid_charge_type' });
      return;
    }
    let snap = await getFirestore().collection('cobrancas_pix').doc(`${found.data.id}_${tipo}`).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'charge_not_found' });
      return;
    }
    if (snap.data().grupo_id) {
      snap = await getFirestore().collection('cobrancas_pix').doc(snap.data().grupo_id).get();
      if (!snap.exists || snap.data().cliente_id !== session.clienteId) {
        res.status(404).json({ ok: false, error: 'charge_not_found' });
        return;
      }
    }
    snap = await refreshPendingCharge(snap);
    res.json({ ok: true, charge: publicCharge(snap.data()) });
  });

  app.use('/portal-api', router);

  app.post(['/mercadopago/webhook', '/mercadopago/webhook/:pathSecret'], async (req, res) => {
    const dataId = String(req.query['data.id'] || req.query.data_id || req.body?.data?.id || '');
    const signatureOk = verifyWebhookSignature({
      xSignature: req.headers['x-signature'],
      xRequestId: req.headers['x-request-id'],
      dataId,
    });
    const pathSecretOk = verifyWebhookPathSecret(req.params.pathSecret);
    if (!signatureOk && !pathSecretOk) {
      res.status(401).end();
      return;
    }
    const eventType = String(req.body?.type || req.query.type || '').toLowerCase();
    if (eventType && eventType !== 'order') {
      res.status(200).end();
      return;
    }
    try {
      await processOrderWebhook(dataId);
      res.status(200).end();
    } catch (error) {
      logger.error('[mercadopago] Erro ao processar webhook:', error.response?.data || error.message);
      res.status(500).end();
    }
  });

  startPixReconciliation();
}

module.exports = {
  setupMercadoPago,
  verifyWebhookSignature,
  verifyWebhookPathSecret,
  createPixCharge,
  processOrderWebhook,
  extractPix,
  isValidEmail,
  buildExternalReference,
  parseExternalReference,
  vipChargeId,
  createVipPixCharge,
  refreshPendingCharge,
  reconcilePendingPixCharges,
};
