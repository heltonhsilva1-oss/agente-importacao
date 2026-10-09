'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diasParaVencimento, statusMensalidadeEfetivo, mensalidadeEmCobranca } = require('../mensalidade');
const { mensagemMensalidadeVip } = require('../agendamentos');
const { readFileSync } = require('node:fs');

test('cobra durante os cinco dias posteriores ao vencimento com PAGAR e SAIR', () => {
  for (const atraso of [-1, -2, -3, -4, -5]) {
    const mensagem = mensagemMensalidadeVip({ nome: 'Cliente', data_vencimento_mensalidade: 12 }, atraso, 50, Math.abs(atraso));
    assert.match(mensagem, /PAGAR/);
    assert.match(mensagem, /SAIR/);
    assert.match(mensagem, /R\$\s*50,00/);
    assert.match(mensagem, /venceu no dia \*12\*/);
    assert.match(mensagem, new RegExp(`aviso \\*${Math.abs(atraso)} de 5\\*`));
    assert.doesNotMatch(mensagem, /vencida há/);
  }
});

test('pagamento do mês anterior não mantém a mensalidade paga', () => {
  const cliente = { status_mensalidade: 'paga', data_pagamento_mensalidade: '2026-09-05', data_vencimento_mensalidade: 5 };
  assert.equal(statusMensalidadeEfetivo(cliente, { year: 2026, month: 10, day: 7 }), 'vencida');
});

test('PAGAR é aceito no próprio dia do vencimento oferecido pelo aviso', () => {
  const cliente = {
    tipo_cliente: 'vip', status_mensalidade: 'paga',
    data_pagamento_mensalidade: '2026-09-09', data_vencimento_mensalidade: 9,
  };
  assert.equal(statusMensalidadeEfetivo(cliente, { year: 2026, month: 10, day: 9 }), 'pendente');
  assert.equal(mensalidadeEmCobranca(cliente, { year: 2026, month: 10, day: 9 }), true);
});

test('mensalidade paga no mês e cliente Free não entram em cobrança', () => {
  const paga = {
    tipo_cliente: 'vip', status_mensalidade: 'paga',
    data_pagamento_mensalidade: '2026-10-09', data_vencimento_mensalidade: 9,
  };
  assert.equal(mensalidadeEmCobranca(paga, { year: 2026, month: 10, day: 9 }), false);
  assert.equal(mensalidadeEmCobranca({ ...paga, tipo_cliente: 'free', status_mensalidade: 'pendente' },
    { year: 2026, month: 10, day: 10 }), false);
});

test('vencimento 31 é ajustado ao último dia de mês curto', () => {
  assert.equal(diasParaVencimento(31, { year: 2026, month: 2, day: 28 }), 0);
});

test('vencidos antigos iniciam um ciclo persistente de cinco avisos', () => {
  const source = readFileSync(require.resolve('../agendamentos'), 'utf8');
  assert.match(source, /ciclos_mensalidade_vip/);
  assert.match(source, /avisos_enviados/);
  assert.match(source, /numeroAviso === 5/);
  assert.match(source, /setTimeout\(\(\) => r\(jobAvisoVip\), 5000\)/);
});

