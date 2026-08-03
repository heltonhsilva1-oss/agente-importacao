'use strict';
// Cálculo de status de mensalidade VIP em horário de Brasília — Railway roda
// em UTC, então não dá pra usar new Date().getDate() direto.

function hojeSaoPauloYMD(instante = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const partes = Object.fromEntries(fmt.formatToParts(instante).map(p => [p.type, p.value]));
  return { year: Number(partes.year), month: Number(partes.month), day: Number(partes.day) };
}

// Dias até o vencimento deste mês (negativo = já venceu).
function diasParaVencimento(diaVencimento, hoje = hojeSaoPauloYMD()) {
  const vencimentoUtc = Date.UTC(hoje.year, hoje.month - 1, diaVencimento);
  const hojeUtc = Date.UTC(hoje.year, hoje.month - 1, hoje.day);
  return Math.round((vencimentoUtc - hojeUtc) / (24 * 60 * 60 * 1000));
}

// Status real da mensalidade, comparando a data de hoje com o dia de
// vencimento cadastrado. "Paga" só é válida se registrada no mesmo mês/ano
// do vencimento atual — senão um pagamento antigo ficaria válido para sempre.
function statusMensalidadeEfetivo(cliente, hoje = hojeSaoPauloYMD()) {
  const dia = parseInt(cliente?.data_vencimento_mensalidade, 10);
  if (isNaN(dia)) return cliente?.status_mensalidade || 'pendente';

  if (cliente?.status_mensalidade === 'paga' && cliente.data_pagamento_mensalidade) {
    const [py, pm] = String(cliente.data_pagamento_mensalidade).split('-').map(Number);
    if (py === hoje.year && pm === hoje.month) return 'paga';
  }

  return diasParaVencimento(dia, hoje) < 0 ? 'vencida' : 'pendente';
}

module.exports = { hojeSaoPauloYMD, diasParaVencimento, statusMensalidadeEfetivo };
