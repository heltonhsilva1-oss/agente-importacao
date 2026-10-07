'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diasParaVencimento, statusMensalidadeEfetivo } = require('../mensalidade');
const { mensagemMensalidadeVip } = require('../agendamentos');

test('cobra durante os cinco dias posteriores ao vencimento com PAGAR e SAIR', () => {
  for (const atraso of [-1, -2, -3, -4, -5]) {
    const mensagem = mensagemMensalidadeVip({ nome: 'Cliente' }, atraso, 50);
    assert.match(mensagem, /PAGAR/);
    assert.match(mensagem, /SAIR/);
    assert.match(mensagem, /R\$\s*50,00/);
  }
});

test('pagamento do mês anterior não mantém a mensalidade paga', () => {
  const cliente = { status_mensalidade: 'paga', data_pagamento_mensalidade: '2026-09-05', data_vencimento_mensalidade: 5 };
  assert.equal(statusMensalidadeEfetivo(cliente, { year: 2026, month: 10, day: 7 }), 'vencida');
});

test('vencimento 31 é ajustado ao último dia de mês curto', () => {
  assert.equal(diasParaVencimento(31, { year: 2026, month: 2, day: 28 }), 0);
});

