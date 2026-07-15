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

const API_BASE = 'https://api.mercadopago.com';
const CHARGE_TTL_MS = 24 * 60 * 60 * 1000;
const CREATING_TTL_MS = 60 * 1000;

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
    status: data.status,
    tipo: data.tipo,
    valor: data.valor,
    qrCode: data.qr_code || '',
    qrCodeBase64: data.qr_code_base64 || '',
    ticketUrl: data.ticket_url || '',
    expiresAt: timestampMillis(data.expira_em) || null,
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

async function reserveCharge({ pedido, cobranca, email }) {
  const db = getFirestore();
  const chargeId = `${pedido.id}_${cobranca.tipo}`;
  const ref = db.collection('cobrancas_pix').doc(chargeId);
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const current = snap.exists ? snap.data() : null;
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

async function createPixCharge({ pedido, cobranca, email }) {
  const reservation = await reserveCharge({ pedido, cobranca, email });
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
      status: pix.providerStatus === 'processed' ? 'pago' : 'pendente',
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
    await reservation.ref.set(stored, { merge: true });
    return publicCharge({ ...stored, tipo: cobranca.tipo, valor: Number(amount) });
  } catch (error) {
    await reservation.ref.set({
      status: 'erro',
      ultimo_erro: String(error.response?.data?.message || error.message).slice(0, 400),
      atualizado_em: Timestamp.now(),
      criando_em: FieldValue.delete(),
    }, { merge: true });
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
    return { paid: false };
  }
  if (charge.status === 'pago') return { paid: true, duplicate: true };

  const result = await confirmarPagamentoPedido(charge.pedido_id, charge.tipo);
  if (!result.ok) throw new Error(`Falha ao confirmar pedido: ${result.motivo}`);
  await chargeRef.set({
    status: 'pago',
    pago_em: Timestamp.now(),
    atualizado_em: Timestamp.now(),
  }, { merge: true });
  return { paid: true };
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
      const charge = await createPixCharge({ pedido: found.data, cobranca, email });
      res.json({ ok: true, charge });
    } catch (error) {
      logger.error('[mercadopago] Falha ao criar Pix:', JSON.stringify(error.response?.data || { message: error.message }));
      res.status(error.status || 502).json({ ok: false, error: 'pix_creation_failed' });
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
    if (!['travessia', 'comissao'].includes(tipo)) {
      res.status(400).json({ ok: false, error: 'invalid_charge_type' });
      return;
    }
    const snap = await getFirestore().collection('cobrancas_pix').doc(`${found.data.id}_${tipo}`).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'charge_not_found' });
      return;
    }
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
};
