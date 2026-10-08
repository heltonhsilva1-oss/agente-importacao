'use strict';
// O backend nunca confia só nos totais gravados pelo frontend para pedidos
// Free: recalcula comissão e travessia a partir do snapshot da regra que o
// pedido usou (a tabela Free é editável e versionada, então a regra de cada
// pedido é a que ficou gravada nele) e dos dados do produto.
// Pedidos VIP passam intactos — o cálculo VIP não é tocado aqui.

const { categoriaFreeValida, valorUnitarioBrl } = require('./tabela-free');

const cents = v => Math.round((Number(v) || 0) * 100);

function totaisFreeConfiaveis(pedido) {
  const produtos = Array.isArray(pedido?.produtos) ? pedido.produtos : [];
  if (!produtos.length) return { ok: false, motivo: 'pedido_free_sem_produtos' };
  let comissao = 0;
  let travessia = 0;
  for (const pr of produtos) {
    const snap = pr?.taxa_snapshot;
    if (!snap || snap.tabela_taxas_aplicada !== 'free') return { ok: false, motivo: 'snapshot_ausente' };
    if (!categoriaFreeValida(snap.categoria_taxa)) return { ok: false, motivo: 'categoria_free_invalida' };
    const quantidade = Number(pr.quantidade) || 0;
    if (quantidade <= 0 || Number(snap.quantidade) !== quantidade) return { ok: false, motivo: 'quantidade_invalida' };

    // O valor unitário do snapshot tem de bater com a nota (USD x cotação).
    const unitario = cents(valorUnitarioBrl(pr.valor_unitario_usd, pedido.cotacao_dolar));
    if (Math.abs(unitario - cents(snap.valor_unitario_brl)) > 1) return { ok: false, motivo: 'valor_unitario_divergente' };

    const pct = snap.percentual_comissao;
    const calculada = pct != null ? Math.round(unitario * Number(pct)) : cents(snap.valor_fixo_comissao);
    const unitFinal = Math.max(calculada, cents(snap.comissao_minima_unitaria));
    comissao += unitFinal * quantidade;
    travessia += cents(snap.travessia_unitaria_brl) * quantidade;
  }
  return { ok: true, comissao: comissao / 100, travessia: travessia / 100 };
}

// Devolve o pedido com totais confiáveis, o próprio pedido (VIP), ou null
// quando um pedido Free está inconsistente e não pode gerar cobrança.
function aplicarTotaisConfiaveis(pedido) {
  if (pedido?.tabela_taxas_aplicada !== 'free') return pedido;
  const t = totaisFreeConfiaveis(pedido);
  if (!t.ok) return null;
  const novo = { ...pedido, total_comissao_brl: t.comissao, total_travessia_brl: t.travessia };
  const pctAnt = Number(pedido.comissao_antecipada_percentual) || 0;
  if (pctAnt > 0) novo.valor_comissao_antecipada_brl = Math.round(t.comissao * pctAnt) / 100;
  return novo;
}

module.exports = { totaisFreeConfiaveis, aplicarTotaisConfiaveis };
