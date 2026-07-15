'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  verifyWebhookSignature,
  verifyWebhookPathSecret,
  extractPix,
  isValidEmail,
} = require('../mercadopago');
const { issuePortalSession, verifyPortalSession } = require('../portal-access');

test('aceita somente o segredo exato no caminho do webhook', () => {
  const secret = 'a'.repeat(64);
  assert.equal(verifyWebhookPathSecret(secret, secret), true);
  assert.equal(verifyWebhookPathSecret('b'.repeat(64), secret), false);
  assert.equal(verifyWebhookPathSecret('', secret), false);
});

test('valida assinatura oficial do webhook com comparação HMAC', () => {
  const secret = 'segredo-de-webhook-com-tamanho-suficiente';
  const dataId = 'ORD01ABCDEF';
  const requestId = 'request-123';
  const ts = '1781009491';
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const signature = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  assert.equal(verifyWebhookSignature({
    xSignature: `ts=${ts},v1=${signature}`,
    xRequestId: requestId,
    dataId,
    secret,
  }), true);
  assert.equal(verifyWebhookSignature({
    xSignature: `ts=${ts},v1=${'0'.repeat(64)}`,
    xRequestId: requestId,
    dataId,
    secret,
  }), false);
});

test('sessão do portal expira e não aceita adulteração', () => {
  const secret = 'abcdef0123456789abcdef0123456789';
  const token = issuePortalSession(42, secret, 1000);
  assert.deepEqual(verifyPortalSession(token, secret, 2000), {
    clienteId: '42',
    exp: 1801000,
  });
  assert.equal(verifyPortalSession(`${token}x`, secret, 2000), null);
  assert.equal(verifyPortalSession(token, secret, 1801001), null);
});

test('extrai somente os dados públicos necessários do Pix', () => {
  assert.deepEqual(extractPix({
    id: 'ORD123',
    status: 'action_required',
    transactions: { payments: [{ payment_method: {
      qr_code: '000201',
      qr_code_base64: 'base64',
      ticket_url: 'https://mercadopago.example/pix',
    } }] },
  }), {
    providerOrderId: 'ORD123',
    providerStatus: 'action_required',
    qrCode: '000201',
    qrCodeBase64: 'base64',
    ticketUrl: 'https://mercadopago.example/pix',
  });
});

test('valida e-mail do pagador', () => {
  assert.equal(isValidEmail('cliente@example.com'), true);
  assert.equal(isValidEmail('invalido'), false);
});
