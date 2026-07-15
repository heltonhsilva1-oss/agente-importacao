'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMensagemStatus } = require('../notificacoes');

test('mensagem de travessia direciona o pagamento ao portal', () => {
  const message = buildMensagemStatus('aguardando_pgto_travessia', 'Cliente', 120, 0, '5511999999999');
  assert.match(message, /Pague sua taxa de travessia pelo link/);
  assert.match(message, /minhaimportacao-5442a\.web\.app\/portal/);
  assert.doesNotMatch(message, /envie o comprovante|avise o pagamento/i);
});

test('mensagem de comissão direciona o pagamento ao portal', () => {
  const message = buildMensagemStatus('aguardando_pgto_comissao', 'Cliente', 0, 85, '5511999999999');
  assert.match(message, /Pague hoje pelo link abaixo/);
  assert.match(message, /confirmação é automática/i);
  assert.doesNotMatch(message, /envie o comprovante|avise o pagamento/i);
});
