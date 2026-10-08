'use strict';

const { aplicarTotaisConfiaveis } = require('./financeiro-free');

const PAGAMENTO_PENDENTE = 'pendente';
const PAGAMENTO_PAGO = 'pago';

function getStatusPagamento(pedido, tipo) {
  const campo = tipo === 'travessia'
    ? 'pagamento_travessia'
    : tipo === 'comissao_antecipada'
      ? 'pagamento_comissao_antecipada'
      : 'pagamento_comissao';
  if (pedido?.[campo]) return pedido[campo];
  if (tipo === 'comissao_antecipada') return PAGAMENTO_PENDENTE;
  return pedido?.status_pagamento === PAGAMENTO_PAGO ? PAGAMENTO_PAGO : PAGAMENTO_PENDENTE;
}

function arredondarCentavos(valor) {
  return Math.round((Number(valor) || 0) * 100) / 100;
}

function getValorComissaoAntecipada(pedido) {
  const salvo = Number(pedido?.valor_comissao_antecipada_brl);
  if (Number.isFinite(salvo) && salvo >= 0) return arredondarCentavos(salvo);
  const percentual = Number(pedido?.comissao_antecipada_percentual) || 0;
  return arredondarCentavos((Number(pedido?.total_comissao_brl) || 0) * percentual / 100);
}

function getSaldoComissao(pedidoOriginal) {
  const pedido = aplicarTotaisConfiaveis(pedidoOriginal) || pedidoOriginal;
  const total = arredondarCentavos(pedido?.total_comissao_brl);
  if (getStatusPagamento(pedido, 'comissao_antecipada') !== PAGAMENTO_PAGO) return total;
  return Math.max(0, arredondarCentavos(total - getValorComissaoAntecipada(pedido)));
}

function getCobrancaPendente(pedidoOriginal) {
  if (!pedidoOriginal) return null;
  // Pedido Free: totais recalculados no backend; inconsistente = sem cobrança.
  const pedido = aplicarTotaisConfiaveis(pedidoOriginal);
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
    pedido.status === 'aguardando_pgto_comissao_antecipada' &&
    getStatusPagamento(pedido, 'comissao_antecipada') !== PAGAMENTO_PAGO
  ) {
    return {
      tipo: 'comissao_antecipada',
      valor: getValorComissaoAntecipada(pedido),
      proximoStatus: 'em_transito',
      campoPagamento: 'pagamento_comissao_antecipada',
    };
  }

  if (
    pedido.status === 'aguardando_pgto_comissao' &&
    getStatusPagamento(pedido, 'comissao') !== PAGAMENTO_PAGO
  ) {
    return {
      tipo: 'comissao',
      valor: getSaldoComissao(pedido),
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
  getValorComissaoAntecipada,
  getSaldoComissao,
  getCobrancaPendente,
};
