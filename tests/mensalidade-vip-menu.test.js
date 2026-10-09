'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const menu = readFileSync(require.resolve('../menu'), 'utf8');

test('cliente vencido pode escolher pagar ou sair e o operador é avisado', () => {
  assert.match(menu, /respostaVip === 'PAGAR'/);
  assert.match(menu, /respostaVip === 'SAIR'/);
  assert.match(menu, /solicitou_saida_vip/);
  assert.match(menu, /OPERATOR_PHONE/);
  assert.match(menu, /escolheu \*PAGAR\*/);
  assert.match(menu, /solicitou \*SAIR DO GRUPO VIP\*/);
  assert.match(menu, /createVipPixCharge/);
  assert.match(menu, /mensalidadeEmCobranca\(clienteCadastrado\)/);
  assert.match(menu, /confirmação será automática/);
  assert.match(menu, /updateGroupParticipants/);
});

