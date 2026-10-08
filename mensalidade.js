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
  const ultimoDiaMes = new Date(Date.UTC(hoje.year, hoje.month, 0)).getUTCDate();
  const diaValido = Math.min(Math.max(Number(diaVencimento) || 1, 1), ultimoDiaMes);
  const vencimentoUtc = Date.UTC(hoje.year, hoje.month - 1, diaValido);
  const hojeUtc = Date.UTC(hoje.year, hoje.month - 1, hoje.day);
  return Math.round((vencimentoUtc - hojeUtc) / (24 * 60 * 60 * 1000));
}

function chaveDataSaoPaulo(hoje = hojeSaoPauloYMD()) {
  return `${hoje.year}-${String(hoje.month).padStart(2, '0')}-${String(hoje.day).padStart(2, '0')}`;
}

// Status real da mensalidade, comparando a data de hoje com o dia de
// vencimento cadastrado. "Paga" só é válida se registrada no mesmo mês/ano
// do vencimento atual — senão um pagamento antigo ficaria válido para sempre.
function statusMensalidadeEfetivo(cliente, hoje = hojeSaoPauloYMD()) {
  // Cliente Free não paga mensalidade: nunca fica vencido nem entra em cobrança.
  if (String(cliente?.tipo_cliente || '').toLowerCase() === 'free') return 'isento';
  const dia = parseInt(cliente?.data_vencimento_mensalidade, 10);
  if (isNaN(dia)) return cliente?.status_mensalidade || 'pendente';

  if (cliente?.status_mensalidade === 'paga' && cliente.data_pagamento_mensalidade) {
    const [py, pm] = String(cliente.data_pagamento_mensalidade).split('-').map(Number);
    if (py === hoje.year && pm === hoje.month) return 'paga';
  }

  return diasParaVencimento(dia, hoje) < 0 ? 'vencida' : 'pendente';
}

module.exports = { hojeSaoPauloYMD, diasParaVencimento, chaveDataSaoPaulo, statusMensalidadeEfetivo };
