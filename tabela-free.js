'use strict';
// CÓPIA CJS de src/utils/tabelaFree.js (frontend). Mantida idêntica por
// tests/tabela-free-paridade.test.js — altere os dois arquivos juntos.

//
// Módulo puro e central: toda regra Free vive aqui. A prévia, a validação das
// notas e a gravação definitiva usam as mesmas funções. A tabela VIP continua
// em calc.js/categorias e não é tocada.
//
// Valores monetários são tratados em centavos internamente para evitar erros de
// ponto flutuante nos limites de R$ 1.000,00 / R$ 3.000,00.

const TABELA_FREE_VERSAO = 'free_v1';
const TABELA_FREE_DATA = '2026-10-07';
const COMISSAO_MINIMA_UNITARIA_FREE = 10;
const TRAVESSIA_UNITARIA_FREE = 9.99;
const LIMITE_IPAD_MACBOOK_POR_VIAGEM = 2;

const TIPOS_CLIENTE = ['vip', 'free'];

const CATEGORIAS_FREE = [
  { id: 'perfume_cosmetico', nome: 'Perfumes e cosméticos' },
  { id: 'xiaomi_aparelho', nome: 'Xiaomi — aparelhos' },
  { id: 'tablet_xiaomi_samsung', nome: 'Tablets Xiaomi e Samsung' },
  { id: 'iphone_lacrado', nome: 'iPhone lacrado' },
  { id: 'iphone_seminovo', nome: 'iPhone seminovo' },
  { id: 'apple_watch_lacrado', nome: 'Apple Watch lacrado' },
  { id: 'console_games', nome: 'Xbox, PlayStation e Nintendo Switch' },
  { id: 'ipad_macbook', nome: 'iPad e MacBook', limite_por_viagem: LIMITE_IPAD_MACBOOK_POR_VIAGEM },
  { id: 'eletronico_medio', nome: 'Eletrônico de médio porte / drones' },
  { id: 'eletronico_geral', nome: 'Eletrônicos em geral' },
];

const IDS_FREE = new Set(CATEGORIAS_FREE.map(c => c.id));

function categoriaFreePorId(id) {
  return CATEGORIAS_FREE.find(c => c.id === id) || null;
}

function categoriaFreeValida(id) {
  return IDS_FREE.has(id);
}

// ── tipo do cliente ──────────────────────────────────────────────────────────

// Retorna 'vip', 'free' ou null (cliente ainda não classificado).
function getTipoCliente(cliente) {
  const tipo = String(cliente?.tipo_cliente || '').toLowerCase();
  return TIPOS_CLIENTE.includes(tipo) ? tipo : null;
}

function isClienteFree(cliente) {
  return getTipoCliente(cliente) === 'free';
}

function isClienteVip(cliente) {
  return getTipoCliente(cliente) === 'vip';
}

// ── aritmética em centavos ───────────────────────────────────────────────────

const cents = v => Math.round((Number(v) || 0) * 100);
const brl = c => c / 100;

// Valor unitário em reais, arredondado ao centavo, usando a cotação do pedido.
function valorUnitarioBrl(valorUnitarioUsd, cotacao) {
  return brl(Math.round((Number(valorUnitarioUsd) || 0) * (Number(cotacao) || 0) * 100));
}

// ── regras ───────────────────────────────────────────────────────────────────

// Devolve a regra aplicável: { descricao, percentual?, valor_fixo? } (centavos
// só internamente). `qtdAcumulada` é a soma de unidades da mesma categoria do
// mesmo cliente na mesma viagem (incluindo esta linha).
function regraDaCategoria(categoriaId, valorBrl, qtdAcumulada) {
  const v = cents(valorBrl);
  const q = Number(qtdAcumulada) || 0;
  switch (categoriaId) {
    case 'perfume_cosmetico':
      return { descricao: 'Perfumes e cosméticos: 20% do valor unitário', percentual: 0.20 };
    case 'xiaomi_aparelho':
      if (v >= 100000) return { descricao: 'Xiaomi a partir de R$ 1.000,00: 10% do valor unitário', percentual: 0.10 };
      return q >= 3
        ? { descricao: 'Xiaomi abaixo de R$ 1.000,00 (3 ou mais un.): R$ 70,00 por unidade', valor_fixo: 70 }
        : { descricao: 'Xiaomi abaixo de R$ 1.000,00 (até 2 un.): R$ 80,00 por unidade', valor_fixo: 80 };
    case 'tablet_xiaomi_samsung':
      return v >= 100000
        ? { descricao: 'Tablet Xiaomi/Samsung a partir de R$ 1.000,00: 10% do valor unitário', percentual: 0.10 }
        : { descricao: 'Tablet Xiaomi/Samsung abaixo de R$ 1.000,00: R$ 100,00 por unidade', valor_fixo: 100 };
    case 'iphone_lacrado':
      return { descricao: 'iPhone lacrado: R$ 350,00 por unidade', valor_fixo: 350 };
    case 'iphone_seminovo':
      if (q >= 5) return { descricao: 'iPhone seminovo (5 ou mais un.): R$ 120,00 por unidade', valor_fixo: 120 };
      if (q >= 3) return { descricao: 'iPhone seminovo (3 a 4 un.): R$ 140,00 por unidade', valor_fixo: 140 };
      return { descricao: 'iPhone seminovo (até 2 un.): R$ 170,00 por unidade', valor_fixo: 170 };
    case 'apple_watch_lacrado':
      return { descricao: 'Apple Watch lacrado: 10% do valor unitário', percentual: 0.10 };
    case 'console_games':
      return { descricao: 'Xbox, PlayStation e Switch: 14% do valor unitário', percentual: 0.14 };
    case 'ipad_macbook':
      return { descricao: 'iPad e MacBook: 10% do valor unitário (máx. 2 un. por viagem)', percentual: 0.10 };
    case 'eletronico_medio':
      return v >= 300000
        ? { descricao: 'Eletrônico de médio porte a partir de R$ 3.000,00: 10% do valor unitário', percentual: 0.10 }
        : { descricao: 'Eletrônico de médio porte abaixo de R$ 3.000,00: 15% do valor unitário', percentual: 0.15 };
    case 'eletronico_geral':
      return { descricao: 'Eletrônicos em geral: 15% do valor unitário', percentual: 0.15 };
    default:
      return null;
  }
}

// Calcula o snapshot financeiro imutável de UMA linha de produto.
//   categoriaId     id em CATEGORIAS_FREE
//   valorUnitarioBrl valor unitário já convertido para reais
//   quantidade      unidades da linha
//   quantidadeAcumulada unidades da categoria na viagem (incluindo a linha)
//   cotacao         cotação do pedido, só registrada no snapshot
function calcularItemFree({
  categoriaId, valorUnitarioBrl: valorBrl, quantidade, quantidadeAcumulada, cotacao = null,
}) {
  const qtd = Number(quantidade) || 0;
  const regra = regraDaCategoria(categoriaId, valorBrl, quantidadeAcumulada ?? qtd);
  if (!regra) {
    throw new Error(`Categoria Free inválida: ${categoriaId || '(vazia)'}`);
  }
  const unitBrl = brl(cents(valorBrl));
  const calculadaCents = regra.percentual != null
    ? Math.round(cents(unitBrl) * regra.percentual)
    : cents(regra.valor_fixo);
  const finalCents = Math.max(calculadaCents, cents(COMISSAO_MINIMA_UNITARIA_FREE));
  const minimoAplicado = finalCents > calculadaCents;
  const travUnitCents = cents(TRAVESSIA_UNITARIA_FREE);

  return {
    tipo_cliente_aplicado: 'free',
    tabela_taxas_aplicada: 'free',
    tabela_versao: TABELA_FREE_VERSAO,
    tabela_data: TABELA_FREE_DATA,
    categoria_taxa: categoriaId,
    categoria_taxa_nome: categoriaFreePorId(categoriaId)?.nome || categoriaId,
    descricao_regra: minimoAplicado
      ? `${regra.descricao} — aplicada comissão mínima de R$ 10,00 por unidade`
      : regra.descricao,
    valor_unitario_brl: unitBrl,
    quantidade,
    quantidade_considerada: Number(quantidadeAcumulada ?? qtd) || 0,
    percentual_comissao: regra.percentual ?? null,
    valor_fixo_comissao: regra.valor_fixo ?? null,
    comissao_minima_unitaria: COMISSAO_MINIMA_UNITARIA_FREE,
    comissao_minima_aplicada: minimoAplicado,
    comissao_unitaria_calculada: brl(calculadaCents),
    comissao_unitaria_final: brl(finalCents),
    total_comissao_brl: brl(finalCents * qtd),
    travessia_unitaria_brl: brl(travUnitCents),
    total_travessia_brl: brl(travUnitCents * qtd),
    cotacao_aplicada: cotacao == null ? null : Number(cotacao),
  };
}

// ── limite iPad/MacBook ──────────────────────────────────────────────────────

// `jaAceitas` = unidades de iPad/MacBook do cliente na viagem em OUTROS pedidos.
function validarLimiteIpadMacbook({ jaAceitas = 0, naNota = 0 }) {
  const total = (Number(jaAceitas) || 0) + (Number(naNota) || 0);
  if (total <= LIMITE_IPAD_MACBOOK_POR_VIAGEM) return { ok: true, total };
  return {
    ok: false,
    total,
    mensagem:
      `Clientes Free podem comprar no máximo ${LIMITE_IPAD_MACBOOK_POR_VIAGEM} unidades de iPad/MacBook por viagem. ` +
      `Já há ${Number(jaAceitas) || 0} aceita(s) nesta viagem e esta nota traz ${Number(naNota) || 0}, ` +
      `totalizando ${total}.`,
  };
}

// ── pedido completo ──────────────────────────────────────────────────────────

// Soma as unidades por categoria Free nos pedidos informados.
function somarUnidadesPorCategoriaFree(pedidos = [], ignorarPedidoId = null) {
  const totais = {};
  for (const p of pedidos) {
    if (ignorarPedidoId != null && String(p.id) === String(ignorarPedidoId)) continue;
    for (const pr of p.produtos || []) {
      const cat = pr.categoria_free || pr.taxa_snapshot?.categoria_taxa;
      if (!cat) continue;
      totais[cat] = (totais[cat] || 0) + (Number(pr.quantidade) || 0);
    }
  }
  return totais;
}

// Calcula todos os produtos de um pedido Free.
//   produtos           linhas do pedido (precisam de categoria_free)
//   cotacao            cotação do pedido
//   outrosPedidosDaViagem pedidos do MESMO cliente na MESMA viagem, sem este
// Retorna { itens, totalComissao, totalTravessia, totalACobrar, erros }.
// `erros` lista linhas sem categoria e violações do limite iPad/MacBook; quem
// grava deve recusar o pedido se houver erros.
function calcularPedidoFree({ produtos = [], cotacao, outrosPedidosDaViagem = [] }) {
  const jaNaViagem = somarUnidadesPorCategoriaFree(outrosPedidosDaViagem);
  const nestePedido = {};
  for (const pr of produtos) {
    if (!pr.categoria_free) continue;
    nestePedido[pr.categoria_free] = (nestePedido[pr.categoria_free] || 0) + (Number(pr.quantidade) || 0);
  }

  const erros = [];
  const limite = validarLimiteIpadMacbook({
    jaAceitas: jaNaViagem.ipad_macbook || 0,
    naNota: nestePedido.ipad_macbook || 0,
  });
  if (!limite.ok) erros.push({ tipo: 'limite_ipad_macbook', mensagem: limite.mensagem });

  const itens = produtos.map((pr, indice) => {
    if (!categoriaFreeValida(pr.categoria_free)) {
      erros.push({
        tipo: 'sem_categoria', indice,
        mensagem: `Produto "${pr.descricao || indice + 1}" sem categoria Free definida.`,
      });
      return null;
    }
    const acumulada = (jaNaViagem[pr.categoria_free] || 0) + (nestePedido[pr.categoria_free] || 0);
    return calcularItemFree({
      categoriaId: pr.categoria_free,
      valorUnitarioBrl: valorUnitarioBrl(pr.valor_unitario_usd, cotacao),
      quantidade: Number(pr.quantidade) || 0,
      quantidadeAcumulada: acumulada,
      cotacao,
    });
  });

  const validos = itens.filter(Boolean);
  const totalComissao = brl(validos.reduce((s, i) => s + cents(i.total_comissao_brl), 0));
  const totalTravessia = brl(validos.reduce((s, i) => s + cents(i.total_travessia_brl), 0));
  return {
    itens, totalComissao, totalTravessia,
    totalACobrar: brl(cents(totalComissao) + cents(totalTravessia)),
    erros,
  };
}

// Aplica o cálculo Free a um pedido, devolvendo uma cópia com o snapshot
// imutável em cada produto e os totais na raiz. Lança Error se houver erros.
function snapshotPedidoFree(pedido, { outrosPedidosDaViagem = [], confirmadoPor = null, agora = new Date() } = {}) {
  const calc = calcularPedidoFree({
    produtos: pedido.produtos || [],
    cotacao: pedido.cotacao_dolar,
    outrosPedidosDaViagem,
  });
  if (calc.erros.length) {
    const e = new Error(calc.erros.map(x => x.mensagem).join(' '));
    e.erros = calc.erros;
    throw e;
  }
  const produtos = (pedido.produtos || []).map((pr, i) => ({
    ...pr,
    taxa_travessia_unitaria: TRAVESSIA_UNITARIA_FREE,
    comissao_calculada_brl: calc.itens[i].total_comissao_brl,
    total_travessia_item_brl: calc.itens[i].total_travessia_brl,
    taxa_snapshot: calc.itens[i],
  }));
  const confirmacao = confirmadoPor
    ? { taxa_confirmada_por: confirmadoPor, taxa_confirmada_em: agora.toISOString() }
    : {};
  return {
    ...pedido,
    ...confirmacao,
    tipo_cliente_aplicado: 'free',
    tabela_taxas_aplicada: 'free',
    tabela_taxas_versao: TABELA_FREE_VERSAO,
    produtos,
    total_comissao_brl: calc.totalComissao,
    total_travessia_brl: calc.totalTravessia,
    total_a_cobrar_brl: calc.totalACobrar,
  };
}

// Quando um pedido Free entra/sai/muda, os demais pedidos Free do mesmo
// cliente na mesma viagem podem mudar de faixa (Xiaomi, iPhone seminovo).
// Recalcula os irmãos AINDA NÃO PAGOS; os já pagos nunca são alterados e são
// devolvidos em `congelados` para o operador decidir.
function recalcularFaixasViagemFree({ pedidoAlvo, todosPedidos }) {
  const irmaos = todosPedidos.filter(p =>
    String(p.id) !== String(pedidoAlvo.id) &&
    String(p.cliente_id) === String(pedidoAlvo.cliente_id) &&
    String(p.viagem_id) === String(pedidoAlvo.viagem_id) &&
    p.tabela_taxas_aplicada === 'free');
  const atualizados = [];
  const congelados = [];
  for (const irmao of irmaos) {
    const pago = irmao.pagamento_comissao === 'pago' || irmao.pagamento_comissao_antecipada === 'pago';
    const outros = [pedidoAlvo, ...irmaos.filter(x => x.id !== irmao.id)];
    let novo;
    try {
      novo = snapshotPedidoFree(irmao, { outrosPedidosDaViagem: outros });
    } catch {
      continue;
    }
    if (Math.abs(novo.total_comissao_brl - (irmao.total_comissao_brl || 0)) < 0.005) continue;
    if (pago) congelados.push(irmao.id); else atualizados.push(novo);
  }
  return { atualizados, congelados };
}

// ── sugestão de categoria ────────────────────────────────────────────────────

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Sugere a categoria Free pela descrição do produto. Retorna id ou null.
function sugerirCategoriaFree(descricao) {
  const d = norm(descricao);
  if (!d) return null;
  if (/\b(ipad|macbook|mac book|imac|mac mini)\b/.test(d)) return 'ipad_macbook';
  if (/(apple watch|iwatch)/.test(d)) return 'apple_watch_lacrado';
  if (/(iphone)/.test(d)) return /(seminovo|semi novo|semi-novo|usado)/.test(d) ? 'iphone_seminovo' : 'iphone_lacrado';
  if (/(xbox|playstation|\bps ?[345]\b|nintendo|switch)/.test(d)) return 'console_games';
  if (/(tablet|\btab\b|galaxy tab|redmi pad|xiaomi pad|\bpad\b)/.test(d)) return 'tablet_xiaomi_samsung';
  if (/(xiaomi|redmi|poco)/.test(d)) return 'xiaomi_aparelho';
  if (/(perfume|cosmetic|eau de|parfum|colonia|hidratante|creme|maquiagem|batom)/.test(d)) return 'perfume_cosmetico';
  if (/(drone|dji|camera|gopro|notebook|laptop|monitor|projetor|smart ?tv|caixa de som|soundbar)/.test(d)) return 'eletronico_medio';
  if (/(alexa|echo|carregador|fone|airpods|cabo|capinha|mouse|teclado|relogio|smartwatch|celular|smartphone|galaxy)/.test(d)) return 'eletronico_geral';
  return null;
}

module.exports = {
  TABELA_FREE_VERSAO,
  TABELA_FREE_DATA,
  COMISSAO_MINIMA_UNITARIA_FREE,
  TRAVESSIA_UNITARIA_FREE,
  LIMITE_IPAD_MACBOOK_POR_VIAGEM,
  TIPOS_CLIENTE,
  CATEGORIAS_FREE,
  categoriaFreePorId,
  categoriaFreeValida,
  getTipoCliente,
  isClienteFree,
  isClienteVip,
  valorUnitarioBrl,
  calcularItemFree,
  validarLimiteIpadMacbook,
  somarUnidadesPorCategoriaFree,
  calcularPedidoFree,
  snapshotPedidoFree,
  recalcularFaixasViagemFree,
  sugerirCategoriaFree,
};
