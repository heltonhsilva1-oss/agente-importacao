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
// vencimento cadastrado — não depende de o campo status_mensalidade ter
// sido atualizado manualmente.
function statusMensalidadeEfetivo(cliente, hoje = hojeSaoPauloYMD()) {
  if (cliente?.status_mensalidade === 'paga') return 'paga';

  const dia = parseInt(cliente?.data_vencimento_mensalidade, 10);
  if (isNaN(dia)) return cliente?.status_mensalidade || 'pendente';

  return diasParaVencimento(dia, hoje) < 0 ? 'vencida' : 'pendente';
}

module.exports = { hojeSaoPauloYMD, diasParaVencimento, statusMensalidadeEfetivo };
