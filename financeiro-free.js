'use strict';
// O backend nunca confia só nos totais gravados pelo frontend para pedidos
// Free: recalcula comissão e travessia a partir dos dados do produto com a
// mesma tabela (free_v1) antes de gerar qualquer cobrança.
// Pedidos VIP passam intactos — o cálculo VIP não é tocado aqui.

const { calcularItemFree, categoriaFreeValida, valorUnitarioBrl } = require('./tabela-free');

const cents = v => Math.round((Number(v) || 0) * 100);

function totaisFreeConfiaveis(pedido) {
  const produtos = Array.isArray(pedido?.produtos) ? pedido.produtos : [];
  if (!produtos.length) return { ok: false, motivo: 'pedido_free_sem_produtos' };
  let comissao = 0;
  let travessia = 0;
  for (const pr of produtos) {
    const snap = pr?.taxa_snapshot;
    const categoria = snap?.categoria_taxa || pr?.categoria_free;
    if (!categoria || !categoriaFreeValida(categoria)) return { ok: false, motivo: 'categoria_free_invalida' };
    const quantidade = Number(pr.quantidade) || 0;
    if (quantidade <= 0) return { ok: false, motivo: 'quantidade_invalida' };
    const acumulada = Math.max(quantidade, Number(snap?.quantidade_considerada) || quantidade);
    const item = calcularItemFree({
      categoriaId: categoria,
      valorUnitarioBrl: valorUnitarioBrl(pr.valor_unitario_usd, pedido.cotacao_dolar),
      quantidade, quantidadeAcumulada: acumulada, cotacao: pedido.cotacao_dolar,
    });
    comissao += cents(item.total_comissao_brl);
    travessia += cents(item.total_travessia_brl);
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
  const pct = Number(pedido.comissao_antecipada_percentual) || 0;
  if (pct > 0) novo.valor_comissao_antecipada_brl = Math.round(t.comissao * pct) / 100;
  return novo;
}

module.exports = { totaisFreeConfiaveis, aplicarTotaisConfiaveis };
