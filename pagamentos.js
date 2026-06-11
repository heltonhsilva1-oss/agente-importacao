'use strict';

const PAGAMENTO_PENDENTE = 'pendente';
const PAGAMENTO_PAGO = 'pago';

function getStatusPagamento(pedido, tipo) {
  const campo = tipo === 'travessia' ? 'pagamento_travessia' : 'pagamento_comissao';
  if (pedido?.[campo]) return pedido[campo];
  return pedido?.status_pagamento === PAGAMENTO_PAGO ? PAGAMENTO_PAGO : PAGAMENTO_PENDENTE;
}

function getCobrancaPendente(pedido) {
  if (!pedido) return null;

  if (
    pedido.status === 'aguardando_pgto_travessia' &&
    getStatusPagamento(pedido, 'travessia') !== PAGAMENTO_PAGO
  ) {
    return {
      tipo: 'travessia',
      valor: Number(pedido.total_travessia_brl) || 0,
      proximoStatus: 'em_transito',
      campoPagamento: 'pagamento_travessia',
    };
  }

  if (
    pedido.status === 'aguardando_pgto_comissao' &&
    getStatusPagamento(pedido, 'comissao') !== PAGAMENTO_PAGO
  ) {
    return {
      tipo: 'comissao',
      valor: Number(pedido.total_comissao_brl) || 0,
      proximoStatus: 'aguardando_etiqueta',
      campoPagamento: 'pagamento_comissao',
    };
  }

  return null;
}

module.exports = {
  PAGAMENTO_PENDENTE,
  PAGAMENTO_PAGO,
  getStatusPagamento,
  getCobrancaPendente,
};
