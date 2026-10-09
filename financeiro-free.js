'use strict';
// O backend nunca confia só nos totais gravados pelo frontend para pedidos
// Free: recalcula comissão e travessia a partir do snapshot da regra que o
// pedido usou (a tabela Free é editável e versionada, então a regra de cada
// pedido é a que ficou gravada nele) e dos dados do produto.
// Pedidos VIP passam intactos — o cálculo VIP não é tocado aqui.

const { categoriaFreeValida, valorUnitarioBrl, calcularItemFree } = require('./tabela-free');
const { getTabelaFreePorVersao } = require('./tabelas-free-store');

const cents = v => Math.round((Number(v) || 0) * 100);

function totaisFreeConfiaveis(pedido, buscarTabela = getTabelaFreePorVersao) {
  const produtos = Array.isArray(pedido?.produtos) ? pedido.produtos : [];
  if (!produtos.length) return { ok: false, motivo: 'pedido_free_sem_produtos' };
  const versao = String(pedido.tabela_taxas_versao || '');
  const tabela = buscarTabela(versao);
  if (!tabela) return { ok: false, motivo: 'tabela_historica_indisponivel' };
  let comissao = 0;
  let travessia = 0;
  for (const pr of produtos) {
    const snap = pr?.taxa_snapshot;
    if (!snap || snap.tabela_taxas_aplicada !== 'free') return { ok: false, motivo: 'snapshot_ausente' };
    if (!categoriaFreeValida(snap.categoria_taxa)) return { ok: false, motivo: 'categoria_free_invalida' };
    if (String(snap.tabela_versao) !== versao) return { ok: false, motivo: 'versao_snapshot_divergente' };
    if (pr.categoria_free && pr.categoria_free !== snap.categoria_taxa) return { ok: false, motivo: 'categoria_snapshot_divergente' };
    const quantidade = Number(pr.quantidade) || 0;
    if (quantidade <= 0 || Number(snap.quantidade) !== quantidade) return { ok: false, motivo: 'quantidade_invalida' };
    const considerada = Number(snap.quantidade_considerada);
    if (!Number.isInteger(considerada) || considerada < quantidade) return { ok: false, motivo: 'quantidade_considerada_invalida' };

    // O valor unitário do snapshot tem de bater com a nota (USD x cotação).
    const unitario = cents(valorUnitarioBrl(pr.valor_unitario_usd, pedido.cotacao_dolar));
    if (Math.abs(unitario - cents(snap.valor_unitario_brl)) > 1) return { ok: false, motivo: 'valor_unitario_divergente' };

    const canonico = calcularItemFree({
      categoriaId: snap.categoria_taxa,
      valorUnitarioBrl: unitario / 100,
      quantidade,
      quantidadeAcumulada: considerada,
      cotacao: pedido.cotacao_dolar,
      tabela,
    });
    comissao += cents(canonico.total_comissao_brl);
    travessia += cents(canonico.total_travessia_brl);
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
