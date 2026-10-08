'use strict';
// CÓPIA CJS de src/utils/tabelaFree.js (frontend). Mantida idêntica por
// tests/tabela-free-paridade.test.js — altere os dois arquivos juntos.

//
// Módulo puro e central: toda regra Free vive aqui. A prévia, a validação das
// notas e a gravação definitiva usam as mesmas funções. A tabela VIP continua
// em calc.js/categorias e não é tocada.
//
// A tabela vigente fica no Firestore (configuracoes/tabela_free); sem ela vale
// TABELA_FREE_PADRAO (free_v1). Cada salvamento gera uma versão nova (free_v2,
// free_v3…) e cada pedido guarda o snapshot completo da regra que usou, então
// alterar a tabela (ex.: promoção) nunca recalcula pedidos antigos.
//
// Modelo de uma categoria:
//   bandas: [{ a_partir_de: <R$ unitário>, faixas: [{ qtd_a_partir_de, tipo, valor }] }]
//   - a banda aplicável é a de maior `a_partir_de` <= valor unitário em reais;
//   - dentro dela, a faixa de maior `qtd_a_partir_de` <= quantidade acumulada
//     do cliente na viagem;
//   - tipo 'percentual' (valor = fração, 0.2 = 20%) ou 'fixo' (R$ por unidade).
//
// Valores monetários são tratados em centavos internamente para evitar erros de
// ponto flutuante nos limites de R$ 1.000,00 / R$ 3.000,00.

const TABELA_FREE_VERSAO = 'free_v1';
const TABELA_FREE_DATA = '2026-10-07';
const COMISSAO_MINIMA_UNITARIA_FREE = 10;
const TRAVESSIA_UNITARIA_FREE = 9.99;
const LIMITE_IPAD_MACBOOK_POR_VIAGEM = 2;

const TIPOS_CLIENTE = ['vip', 'free'];

// As categorias (ids e nomes) são fixas; os valores de cada uma são editáveis.
const CATEGORIAS_FREE = [
  { id: 'perfume_cosmetico', nome: 'Perfumes e cosméticos' },
  { id: 'xiaomi_aparelho', nome: 'Xiaomi — aparelhos' },
  { id: 'tablet_xiaomi_samsung', nome: 'Tablets Xiaomi e Samsung' },
  { id: 'iphone_lacrado', nome: 'iPhone lacrado' },
  { id: 'iphone_seminovo', nome: 'iPhone seminovo' },
  { id: 'apple_watch_lacrado', nome: 'Apple Watch lacrado' },
  { id: 'console_games', nome: 'Xbox, PlayStation e Nintendo Switch' },
  { id: 'ipad_macbook', nome: 'iPad e MacBook' },
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

// ── tabela padrão (free_v1) ──────────────────────────────────────────────────

const pct = valor => ({ qtd_a_partir_de: 1, tipo: 'percentual', valor });
const fixo = (valor, qtd = 1) => ({ qtd_a_partir_de: qtd, tipo: 'fixo', valor });
const banda = (a_partir_de, faixas) => ({ a_partir_de, faixas });

const TABELA_FREE_PADRAO = Object.freeze({
  versao: TABELA_FREE_VERSAO,
  rotulo: 'Tabela inicial',
  atualizada_em: TABELA_FREE_DATA,
  atualizada_por: null,
  comissao_minima_unitaria: COMISSAO_MINIMA_UNITARIA_FREE,
  travessia_unitaria: TRAVESSIA_UNITARIA_FREE,
  categorias: {
    perfume_cosmetico: { bandas: [banda(0, [pct(0.20)])] },
    xiaomi_aparelho: {
      bandas: [banda(0, [fixo(80, 1), fixo(70, 3)]), banda(1000, [pct(0.10)])],
    },
    tablet_xiaomi_samsung: { bandas: [banda(0, [fixo(100)]), banda(1000, [pct(0.10)])] },
    iphone_lacrado: { bandas: [banda(0, [fixo(350)])] },
    iphone_seminovo: { bandas: [banda(0, [fixo(170, 1), fixo(140, 3), fixo(120, 5)])] },
    apple_watch_lacrado: { bandas: [banda(0, [pct(0.10)])] },
    console_games: { bandas: [banda(0, [pct(0.14)])] },
    ipad_macbook: {
      bandas: [banda(0, [pct(0.10)])],
      limite_por_viagem: LIMITE_IPAD_MACBOOK_POR_VIAGEM,
    },
    eletronico_medio: { bandas: [banda(0, [pct(0.15)]), banda(3000, [pct(0.10)])] },
    eletronico_geral: { bandas: [banda(0, [pct(0.15)])] },
  },
});

// ── validação / normalização da tabela ───────────────────────────────────────

// Devolve a lista de problemas (vazia = tabela válida).
function validarTabelaFree(tabela) {
  const erros = [];
  const num = v => typeof v === 'number' && Number.isFinite(v);
  if (!tabela || typeof tabela !== 'object') return ['Tabela ausente.'];
  if (!num(tabela.comissao_minima_unitaria) || tabela.comissao_minima_unitaria < 0) erros.push('Comissão mínima inválida.');
  if (!num(tabela.travessia_unitaria) || tabela.travessia_unitaria < 0) erros.push('Travessia inválida.');
  for (const cat of CATEGORIAS_FREE) {
    const c = tabela.categorias?.[cat.id];
    if (!c || !Array.isArray(c.bandas) || !c.bandas.length) { erros.push(`${cat.nome}: sem regras.`); continue; }
    if (c.limite_por_viagem != null && !(Number.isInteger(c.limite_por_viagem) && c.limite_por_viagem > 0)) {
      erros.push(`${cat.nome}: limite por viagem inválido.`);
    }
    if (c.bandas[0].a_partir_de !== 0) erros.push(`${cat.nome}: a primeira faixa de valor deve começar em R$ 0.`);
    c.bandas.forEach((b, i) => {
      if (!num(b.a_partir_de) || b.a_partir_de < 0) erros.push(`${cat.nome}: valor inicial inválido.`);
      if (i > 0 && !(b.a_partir_de > c.bandas[i - 1].a_partir_de)) erros.push(`${cat.nome}: as faixas de valor devem estar em ordem crescente.`);
      if (!Array.isArray(b.faixas) || !b.faixas.length) { erros.push(`${cat.nome}: faixa de valor sem regra.`); return; }
      if (b.faixas[0].qtd_a_partir_de !== 1) erros.push(`${cat.nome}: a primeira faixa de quantidade deve começar em 1.`);
      b.faixas.forEach((f, j) => {
        if (!Number.isInteger(f.qtd_a_partir_de) || f.qtd_a_partir_de < 1) erros.push(`${cat.nome}: quantidade inicial inválida.`);
        if (j > 0 && !(f.qtd_a_partir_de > b.faixas[j - 1].qtd_a_partir_de)) erros.push(`${cat.nome}: as faixas de quantidade devem estar em ordem crescente.`);
        if (!['fixo', 'percentual'].includes(f.tipo)) erros.push(`${cat.nome}: tipo de taxa inválido.`);
        if (!num(f.valor) || f.valor < 0) erros.push(`${cat.nome}: valor inválido.`);
        if (f.tipo === 'percentual' && f.valor > 1) erros.push(`${cat.nome}: percentual acima de 100%.`);
      });
    });
  }
  return erros;
}

// Usa a tabela salva se for válida; senão cai na padrão (nunca calcula com tabela quebrada).
function normalizarTabelaFree(salva) {
  if (!salva) return TABELA_FREE_PADRAO;
  return validarTabelaFree(salva).length ? TABELA_FREE_PADRAO : salva;
}

function proximaVersaoTabelaFree(versaoAtual) {
  const n = Number(String(versaoAtual || '').replace(/^\D+/, '').replace(/^v/, '')) || 1;
  return `free_v${n + 1}`;
}

function limiteCategoriaFree(categoriaId, tabela = TABELA_FREE_PADRAO) {
  return tabela.categorias?.[categoriaId]?.limite_por_viagem ?? null;
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
const moeda = v => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctTexto = f => `${Math.round(f * 1000) / 10}%`.replace('.', ',');

// Valor unitário em reais, arredondado ao centavo, usando a cotação do pedido.
function valorUnitarioBrl(valorUnitarioUsd, cotacao) {
  return brl(Math.round((Number(valorUnitarioUsd) || 0) * (Number(cotacao) || 0) * 100));
}

// ── regras ───────────────────────────────────────────────────────────────────

function descreverRegra(nome, c, iBanda, iFaixa) {
  const b = c.bandas[iBanda];
  const f = b.faixas[iFaixa];
  const partes = [];
  if (c.bandas.length > 1) {
    const proxima = c.bandas[iBanda + 1];
    if (iBanda === 0) partes.push(`abaixo de ${moeda(proxima.a_partir_de)}`);
    else partes.push(`a partir de ${moeda(b.a_partir_de)}`);
  }
  if (b.faixas.length > 1) {
    const proxima = b.faixas[iFaixa + 1];
    if (!proxima) partes.push(`${f.qtd_a_partir_de} ou mais un.`);
    else if (proxima.qtd_a_partir_de - 1 === f.qtd_a_partir_de) partes.push(`${f.qtd_a_partir_de} un.`);
    else if (iFaixa === 0) partes.push(`até ${proxima.qtd_a_partir_de - 1} un.`);
    else partes.push(`${f.qtd_a_partir_de} a ${proxima.qtd_a_partir_de - 1} un.`);
  }
  const taxa = f.tipo === 'percentual'
    ? `${pctTexto(f.valor)} do valor unitário`
    : `${moeda(f.valor)} por unidade`;
  return `${nome}${partes.length ? ` (${partes.join(', ')})` : ''}: ${taxa}`;
}

// Escolhe a banda e a faixa aplicáveis e devolve a regra resolvida.
function regraDaCategoria(tabela, categoriaId, valorBrl, qtdAcumulada) {
  const cat = categoriaFreePorId(categoriaId);
  const c = tabela.categorias?.[categoriaId];
  if (!cat || !c) return null;
  const v = cents(valorBrl);
  const q = Number(qtdAcumulada) || 0;
  let iBanda = 0;
  c.bandas.forEach((b, i) => { if (cents(b.a_partir_de) <= v) iBanda = i; });
  const faixas = c.bandas[iBanda].faixas;
  let iFaixa = 0;
  faixas.forEach((f, i) => { if (f.qtd_a_partir_de <= q) iFaixa = i; });
  const f = faixas[iFaixa];
  return {
    descricao: descreverRegra(cat.nome, c, iBanda, iFaixa),
    percentual: f.tipo === 'percentual' ? f.valor : null,
    valor_fixo: f.tipo === 'fixo' ? f.valor : null,
  };
}

// Calcula o snapshot financeiro imutável de UMA linha de produto.
//   categoriaId      id em CATEGORIAS_FREE
//   valorUnitarioBrl valor unitário já convertido para reais
//   quantidade       unidades da linha
//   quantidadeAcumulada unidades da categoria na viagem (incluindo a linha)
//   cotacao          cotação do pedido, só registrada no snapshot
//   tabela           tabela vigente (padrão: free_v1)
function calcularItemFree({
  categoriaId, valorUnitarioBrl: valorBrl, quantidade, quantidadeAcumulada, cotacao = null,
  tabela = TABELA_FREE_PADRAO,
}) {
  const qtd = Number(quantidade) || 0;
  const regra = regraDaCategoria(tabela, categoriaId, valorBrl, quantidadeAcumulada ?? qtd);
  if (!regra) {
    throw new Error(`Categoria Free inválida: ${categoriaId || '(vazia)'}`);
  }
  const unitBrl = brl(cents(valorBrl));
  const minimo = tabela.comissao_minima_unitaria;
  const calculadaCents = regra.percentual != null
    ? Math.round(cents(unitBrl) * regra.percentual)
    : cents(regra.valor_fixo);
  const finalCents = Math.max(calculadaCents, cents(minimo));
  const minimoAplicado = finalCents > calculadaCents;
  const travUnitCents = cents(tabela.travessia_unitaria);

  return {
    tipo_cliente_aplicado: 'free',
    tabela_taxas_aplicada: 'free',
    tabela_versao: tabela.versao,
    tabela_data: tabela.atualizada_em,
    tabela_rotulo: tabela.rotulo ?? null,
    categoria_taxa: categoriaId,
    categoria_taxa_nome: categoriaFreePorId(categoriaId)?.nome || categoriaId,
    descricao_regra: minimoAplicado
      ? `${regra.descricao} — aplicada comissão mínima de ${moeda(minimo)} por unidade`
      : regra.descricao,
    valor_unitario_brl: unitBrl,
    quantidade,
    quantidade_considerada: Number(quantidadeAcumulada ?? qtd) || 0,
    percentual_comissao: regra.percentual,
    valor_fixo_comissao: regra.valor_fixo,
    comissao_minima_unitaria: minimo,
    comissao_minima_aplicada: minimoAplicado,
    comissao_unitaria_calculada: brl(calculadaCents),
    comissao_unitaria_final: brl(finalCents),
    total_comissao_brl: brl(finalCents * qtd),
    travessia_unitaria_brl: brl(travUnitCents),
    total_travessia_brl: brl(travUnitCents * qtd),
    cotacao_aplicada: cotacao == null ? null : Number(cotacao),
  };
}

// ── limite por viagem (hoje: iPad/MacBook) ───────────────────────────────────

// `jaAceitas` = unidades do cliente na viagem em OUTROS pedidos.
function validarLimiteIpadMacbook({ jaAceitas = 0, naNota = 0, limite = LIMITE_IPAD_MACBOOK_POR_VIAGEM }) {
  const total = (Number(jaAceitas) || 0) + (Number(naNota) || 0);
  if (total <= limite) return { ok: true, total };
  return {
    ok: false,
    total,
    mensagem:
      `Clientes Free podem comprar no máximo ${limite} unidades de iPad/MacBook por viagem. ` +
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
//   tabela             tabela vigente
// Retorna { itens, totalComissao, totalTravessia, totalACobrar, erros }.
// `erros` lista linhas sem categoria e violações do limite iPad/MacBook; quem
// grava deve recusar o pedido se houver erros.
function calcularPedidoFree({ produtos = [], cotacao, outrosPedidosDaViagem = [], tabela = TABELA_FREE_PADRAO }) {
  const jaNaViagem = somarUnidadesPorCategoriaFree(outrosPedidosDaViagem);
  const nestePedido = {};
  for (const pr of produtos) {
    if (!pr.categoria_free) continue;
    nestePedido[pr.categoria_free] = (nestePedido[pr.categoria_free] || 0) + (Number(pr.quantidade) || 0);
  }

  const erros = [];
  const limiteIpad = limiteCategoriaFree('ipad_macbook', tabela);
  if (limiteIpad != null) {
    const limite = validarLimiteIpadMacbook({
      jaAceitas: jaNaViagem.ipad_macbook || 0,
      naNota: nestePedido.ipad_macbook || 0,
      limite: limiteIpad,
    });
    if (!limite.ok) erros.push({ tipo: 'limite_ipad_macbook', mensagem: limite.mensagem });
  }

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
      tabela,
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
function snapshotPedidoFree(pedido, {
  outrosPedidosDaViagem = [], confirmadoPor = null, agora = new Date(), tabela = TABELA_FREE_PADRAO,
} = {}) {
  const calc = calcularPedidoFree({
    produtos: pedido.produtos || [],
    cotacao: pedido.cotacao_dolar,
    outrosPedidosDaViagem,
    tabela,
  });
  if (calc.erros.length) {
    const e = new Error(calc.erros.map(x => x.mensagem).join(' '));
    e.erros = calc.erros;
    throw e;
  }
  const produtos = (pedido.produtos || []).map((pr, i) => ({
    ...pr,
    taxa_travessia_unitaria: tabela.travessia_unitaria,
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
    tabela_taxas_versao: tabela.versao,
    produtos,
    total_comissao_brl: calc.totalComissao,
    total_travessia_brl: calc.totalTravessia,
    total_a_cobrar_brl: calc.totalACobrar,
  };
}

// Quando um pedido Free entra/sai/muda, os demais pedidos Free do mesmo
// cliente na mesma viagem podem mudar de faixa (Xiaomi, iPhone seminovo).
// Recalcula os irmãos ainda não pagos E calculados na mesma versão da tabela;
// pagos ou de outra versão (ex.: antes de uma promoção) nunca são alterados e
// voltam em `congelados` para o operador decidir.
function recalcularFaixasViagemFree({ pedidoAlvo, todosPedidos, tabela = TABELA_FREE_PADRAO }) {
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
    const mesmaVersao = irmao.tabela_taxas_versao === tabela.versao;
    let novo;
    try {
      // Pedido de outra versão é só simulado na tabela vigente para saber se mudaria.
      novo = snapshotPedidoFree(irmao, { outrosPedidosDaViagem: outros, tabela });
    } catch {
      continue;
    }
    if (Math.abs(novo.total_comissao_brl - (irmao.total_comissao_brl || 0)) < 0.005) continue;
    if (pago || !mesmaVersao) congelados.push(irmao.id); else atualizados.push(novo);
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
  TABELA_FREE_PADRAO,
  validarTabelaFree,
  normalizarTabelaFree,
  proximaVersaoTabelaFree,
  limiteCategoriaFree,
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
