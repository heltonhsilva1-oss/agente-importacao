'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getCobrancaPendente,
  getSaldoComissao,
  getStatusPagamento,
} = require('../pagamentos');

test('backend distingue o adiantamento da comissão definitiva', () => {
  const pedido = {
    status: 'aguardando_pgto_comissao_antecipada',
    total_comissao_brl: 101.01,
    valor_comissao_antecipada_brl: 50.51,
    pagamento_comissao_antecipada: 'pendente',
  };
  assert.deepEqual(getCobrancaPendente(pedido), {
    tipo: 'comissao_antecipada',
    valor: 50.51,
    proximoStatus: 'em_transito',
    campoPagamento: 'pagamento_comissao_antecipada',
  });
  assert.equal(getStatusPagamento(pedido, 'comissao_antecipada'), 'pendente');
});

test('backend desconta somente adiantamento efetivamente pago', () => {
  const pedido = {
    status: 'aguardando_pgto_comissao',
    total_comissao_brl: 101.01,
    valor_comissao_antecipada_brl: 50.51,
    pagamento_comissao_antecipada: 'pago',
    pagamento_comissao: 'pendente',
  };
  assert.equal(getSaldoComissao(pedido), 50.5);
  assert.equal(getCobrancaPendente(pedido).valor, 50.5);
});

test('backend mantém cobrança integral para pedido sem exceção', () => {
  const pedido = {
    status: 'aguardando_pgto_comissao',
    total_comissao_brl: 101.01,
    pagamento_comissao: 'pendente',
  };
  assert.equal(getCobrancaPendente(pedido).valor, 101.01);
});
