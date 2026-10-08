'use strict';

process.env.NOTAS_CONFIRMACAO_MS = '25'; // confirmação agrupada rápida nos testes

const test = require('node:test');
const assert = require('node:assert/strict');
const { carregarComStubs } = require('./helpers/fake-db');

const OPERADOR = '5511995715042';
const CLIENTE = '5511911112222';
const silencio = { logger: { info() {}, warn() {}, error() {} } };

function data(dias) {
  return new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);
}

// `extracao` pode ser um objeto (mesma leitura para toda foto) ou uma função
// (url) => leitura, para simular fotos diferentes.
function montar({ extracao, pedidosAtivos = [], viagem, idadeConversaMs = 0 } = {}) {
  const enviados = [];
  const rascunhos = [];
  let conversa = null;
  const stubFirestore = {
    getConversa: async () => (conversa ? { ...structuredClone(conversa), ultima_atividade: Date.now() - idadeConversaMs } : null),
    setConversa: async (_p, c) => { conversa = structuredClone(c); },
    clearConversa: async () => { conversa = null; },
    findClienteByWhatsapp: async () => ({ id: 1, nome: 'Ana', tipo_cliente: 'free' }),
    getClientesAtivos: async () => [],
    getPedidosAtivos: async () => pedidosAtivos,
    getPedidosPendentes: async () => [],
    getPendentesPagamento: async () => [],
    reservarPendente: async () => null, finalizarPendente: async () => {}, devolverPendenteFila: async () => {},
    confirmarPagamentoPedido: async () => ({}),
    appendHistorico: () => {}, getHistorico: async () => [],
    criarRascunhoPedido: async d => { rascunhos.push(d); return `r${rascunhos.length}`; },
    getConfiguracoes: async () => ({
      horarioCorte: '23:59', diaCorte: 6,
      lojasPadronizadas: [{ id: 'atn', nomeOficial: 'ATN', aliases: ['atn'] }],
    }),
    getViagemMaisRecente: async () => viagem ?? {
      id: 1, status: 'em_andamento', data_saida: data(-1), data_retorno: data(5),
    },
  };
  const menu = carregarComStubs('menu.js', {
    './logger': silencio,
    './claude': {
      responder: async () => null, detectarIntencao: async () => 0,
      extrairProdutosNota: async (url) => (typeof extracao === 'function' ? extracao(url) : extracao),
    },
    './nota-storage': { salvarNotaRecebida: async () => ({ url: 'https://arquivo/nota.jpg' }) },
    './firestore': stubFirestore,
    './uazapi': { sendText: async (phone, texto) => { enviados.push([phone, texto]); } },
    './pagamentos': { getCobrancaPendente: () => null },
    './portal-access': { buildPortalLink: () => 'https://portal' },
  });
  return { menu, enviados, rascunhos, conversa: () => conversa };
}

const esperar = async (cond) => { for (let i = 0; i < 200 && !cond(); i += 1) await new Promise(r => setTimeout(r, 5)); };
const cliente = enviados => enviados.filter(([p]) => p === CLIENTE).map(([, t]) => t);
const foto = (t, n = 1) => t.menu.handleMessage(CLIENTE, 'image', '', `https://midia/${n}`, 'image/jpeg');
const texto = (t, x) => t.menu.handleMessage(CLIENTE, 'text', x, null, null);
const perguntando = t => t.conversa()?.dados?.perguntando ?? null;

const ARQUIVO = { buffer: Buffer.from('x'), mimeType: 'image/jpeg' };
const PRODUTOS = [
  { descricao: 'iPhone', quantidade: 1, valor_unitario_usd: 500 },
  { descricao: 'Capa', quantidade: 2, valor_unitario_usd: 5 },
];
const LEU_TUDO = { produtos: PRODUTOS, loja: 'atn', vendedor: 'João', arquivo: ARQUIVO };
const SO_LOJA = { produtos: PRODUTOS, loja: 'Star Company', vendedor: null, arquivo: ARQUIVO };
const SO_VENDEDOR = { produtos: PRODUTOS, loja: null, vendedor: 'Maria', arquivo: ARQUIVO };
const NADA = { produtos: PRODUTOS, loja: null, vendedor: null, arquivo: ARQUIVO };

// ── uma nota ─────────────────────────────────────────────────────────────────

test('leu loja e vendedor: não pergunta nada, registra e resume para o cliente', async () => {
  const t = montar({ extracao: LEU_TUDO });
  await foto(t);
  await esperar(() => t.rascunhos.length === 1 && cliente(t.enviados).length >= 2);
  const msgs = cliente(t.enviados);
  assert.match(msgs[0], /Recebi sua nota ✅ Já estou lendo/);
  assert.match(msgs[1], /Anotei ✅ Nota 1: \*ATN\* · João\. Já enviei para conferência/);
  assert.match(msgs[1], /PRONTO/);
  assert.equal(t.rascunhos[0].nome_loja, 'ATN'); // padronizada pelas regras de loja
  assert.equal(t.rascunhos[0].nome_vendedor, 'João');
  assert.equal(t.rascunhos[0].extracao_status, 'ok');
  assert.equal(t.rascunhos[0].produtos.length, 2);
  assert.ok(!msgs.some(x => /Pode me dizer|Qual é/.test(x)), 'não pergunta nada');
  assert.ok(t.enviados.some(([p, x]) => p === OPERADOR && /Loja: ATN/.test(x)));
});

test('não leu nem loja nem vendedor: pergunta os dois numa mensagem só', async () => {
  const t = montar({ extracao: NADA });
  await foto(t);
  await esperar(() => perguntando(t) === 1);
  assert.match(cliente(t.enviados).at(-1), /Não consegui ler a \*loja\* e o \*vendedor\*/);
  assert.equal(t.rascunhos.length, 0, 'aguarda a resposta');

  await texto(t, 'atn - João');
  await esperar(() => t.rascunhos.length === 1);
  assert.match(cliente(t.enviados).at(-1), /Anotei ✅ Nota 1: \*ATN\* · João/);
  assert.equal(t.rascunhos[0].nome_loja, 'ATN');
  assert.equal(t.rascunhos[0].nome_vendedor, 'João');
  assert.equal(t.rascunhos[0].produtos.length, 2, 'usa a leitura dos produtos já feita');
});

test('formatos aceitos quando precisa perguntar os dois', async () => {
  for (const [entrada, loja, vendedor] of [
    ['Star Company, Maria', 'Star Company', 'Maria'],
    ['Star Company / Maria Silva', 'Star Company', 'Maria Silva'],
    ['Star Company\nMaria', 'Star Company', 'Maria'],
    ['Star Company', 'Star Company', ''],
  ]) {
    const t = montar({ extracao: NADA });
    await foto(t);
    await esperar(() => perguntando(t) === 1);
    await texto(t, entrada);
    await esperar(() => t.rascunhos.length === 1);
    assert.equal(t.rascunhos[0].nome_loja, loja, entrada);
    assert.equal(t.rascunhos[0].nome_vendedor, vendedor, entrada);
  }
});

test('leu só a loja: pergunta apenas o vendedor', async () => {
  const t = montar({ extracao: SO_LOJA });
  await foto(t);
  await esperar(() => perguntando(t) === 1);
  assert.match(cliente(t.enviados).at(-1), /Li a loja \*Star Company\*, mas não consegui ler o \*vendedor\*/);
  await texto(t, 'Carlos');
  await esperar(() => t.rascunhos.length === 1);
  assert.equal(t.rascunhos[0].nome_loja, 'Star Company');
  assert.equal(t.rascunhos[0].nome_vendedor, 'Carlos');
});

test('leu só o vendedor: pergunta apenas a loja', async () => {
  const t = montar({ extracao: SO_VENDEDOR });
  await foto(t);
  await esperar(() => perguntando(t) === 1);
  assert.match(cliente(t.enviados).at(-1), /Li o vendedor \(\*Maria\*\), mas não consegui ler a \*loja\*/);
  await texto(t, 'atn');
  await esperar(() => t.rascunhos.length === 1);
  assert.equal(t.rascunhos[0].nome_loja, 'ATN');
  assert.equal(t.rascunhos[0].nome_vendedor, 'Maria');
});

test('resposta sem sentido pede de novo', async () => {
  const t = montar({ extracao: NADA });
  await foto(t);
  await esperar(() => perguntando(t) === 1);
  await texto(t, 'x');
  assert.match(cliente(t.enviados).at(-1), /Não entendi/);
  assert.equal(perguntando(t), 1);
});

// ── várias notas de uma vez ──────────────────────────────────────────────────

test('3 fotos de uma vez, todas lidas: 1 confirmação, 1 resumo com as 3 notas, nenhuma perdida', async () => {
  const lojas = { 'https://midia/1': ['atn', 'João'], 'https://midia/2': ['Star Company', 'Maria'], 'https://midia/3': ['atn', 'Pedro'] };
  const t = montar({ extracao: url => ({ produtos: PRODUTOS, loja: lojas[url][0], vendedor: lojas[url][1], arquivo: ARQUIVO }) });
  await Promise.all([foto(t, 1), foto(t, 2), foto(t, 3)]);
  await esperar(() => t.rascunhos.length === 3 && cliente(t.enviados).length >= 2);

  const msgs = cliente(t.enviados);
  assert.equal(msgs.length, 2, 'só duas mensagens ao cliente');
  assert.match(msgs[0], /Recebi 3 notas ✅ Já estou lendo/);
  assert.match(msgs[1], /Anotei ✅ 3 notas já enviadas para conferência/);
  assert.match(msgs[1], /• Nota 1: \*ATN\* · João/);
  assert.match(msgs[1], /• Nota 2: \*Star Company\* · Maria/);
  assert.match(msgs[1], /• Nota 3: \*ATN\* · Pedro/);
  assert.match(msgs[1], /PRONTO/);
  assert.deepEqual(t.rascunhos.map(r => r.nome_vendedor).sort(), ['João', 'Maria', 'Pedro']);
  assert.equal(t.conversa().dados.pendentes.length, 0);
});

test('3 fotos, uma sem dados: registra as 2 lidas e pergunta só da que faltou, citando o número', async () => {
  const leituras = { 'https://midia/1': LEU_TUDO, 'https://midia/2': NADA, 'https://midia/3': { ...LEU_TUDO, vendedor: 'Pedro' } };
  const t = montar({ extracao: url => leituras[url] });
  await Promise.all([foto(t, 1), foto(t, 2), foto(t, 3)]);
  await esperar(() => perguntando(t) === 2);

  const msgs = cliente(t.enviados);
  assert.match(msgs[0], /Recebi 3 notas/);
  assert.match(msgs[1], /Anotei ✅ 2 notas/);
  assert.doesNotMatch(msgs[1], /PRONTO/, 'não pede "mais notas" enquanto há pergunta');
  assert.match(msgs.at(-1), /Nota 2: não consegui ler a \*loja\* e o \*vendedor\*/);
  assert.equal(t.rascunhos.length, 2, 'a nota 2 espera a resposta');

  await texto(t, 'Star Company - Maria');
  await esperar(() => t.rascunhos.length === 3);
  assert.match(cliente(t.enviados).at(-1), /Anotei ✅ Nota 2: \*Star Company\* · Maria/);
  assert.match(cliente(t.enviados).at(-1), /PRONTO/);
});

test('3 fotos sem dados: pergunta uma nota por vez, na ordem', async () => {
  const t = montar({ extracao: NADA });
  await Promise.all([foto(t, 1), foto(t, 2), foto(t, 3)]);
  await esperar(() => perguntando(t) === 1);
  assert.match(cliente(t.enviados).at(-1), /Nota 1: não consegui ler/);

  await texto(t, 'atn - João');
  await esperar(() => perguntando(t) === 2);
  assert.match(cliente(t.enviados).at(-1), /Nota 2: não consegui ler/);
  assert.equal(t.rascunhos.length, 1);

  await texto(t, 'Star Company - Maria');
  await esperar(() => perguntando(t) === 3);
  await texto(t, 'Outra - Pedro');
  await esperar(() => t.rascunhos.length === 3);
  assert.deepEqual(t.rascunhos.map(r => r.nome_loja), ['ATN', 'Star Company', 'Outra']);
  assert.match(cliente(t.enviados).at(-1), /PRONTO/);
});

test('foto nova durante uma pergunta é aceita (não é descartada)', async () => {
  const leituras = { 'https://midia/1': NADA, 'https://midia/2': LEU_TUDO };
  const t = montar({ extracao: url => leituras[url] });
  await foto(t, 1);
  await esperar(() => perguntando(t) === 1);
  await foto(t, 2);
  await esperar(() => t.rascunhos.length === 1); // a nota 2 foi lida e registrada
  assert.equal(perguntando(t), 1, 'a pergunta da nota 1 continua valendo');
  assert.equal(t.conversa().dados.count, 2);
  await texto(t, 'Star Company - Maria');
  await esperar(() => t.rascunhos.length === 2);
});

test('PRONTO enquanto ainda lê: fecha sozinho assim que terminar', async () => {
  let liberar;
  const lenta = new Promise(r => { liberar = r; });
  const t = montar({ extracao: async () => { await lenta; return LEU_TUDO; } });
  await foto(t);
  await texto(t, 'PRONTO');
  assert.match(cliente(t.enviados).at(-1), /Assim que eu terminar de ler/);
  liberar();
  await esperar(() => t.conversa() === null);
  assert.equal(t.rascunhos.length, 1);
  assert.match(cliente(t.enviados).at(-1), /Recebemos 1 nota nesta retirada/);
});

test('PRONTO depois de registrar tudo encerra com a contagem', async () => {
  const t = montar({ extracao: LEU_TUDO });
  await foto(t, 1);
  await esperar(() => t.rascunhos.length === 1);
  await foto(t, 2);
  await esperar(() => t.rascunhos.length === 2);
  assert.ok(cliente(t.enviados).some(x => /Recebi mais uma nota ✅/.test(x)));
  await texto(t, 'PRONTO');
  assert.match(cliente(t.enviados).at(-1), /Recebemos 2 notas/);
  assert.equal(t.conversa(), null);
});

test('PRONTO no meio de uma pergunta insiste na pergunta', async () => {
  const t = montar({ extracao: NADA });
  await foto(t);
  await esperar(() => perguntando(t) === 1);
  await texto(t, 'pronto');
  assert.match(cliente(t.enviados).at(-1), /Antes de finalizar/);
  assert.notEqual(t.conversa(), null);
});

// ── problemas de leitura e situações especiais ───────────────────────────────

test('leitura sem produtos: pergunta loja/vendedor e avisa que a equipe confere', async () => {
  const t = montar({ extracao: { produtos: [], loja: null, vendedor: null, arquivo: ARQUIVO } });
  await foto(t);
  await esperar(() => perguntando(t) === 1);
  await texto(t, 'ATN - João');
  await esperar(() => t.rascunhos.length === 1 && cliente(t.enviados).some(x => /não consegui ler os produtos/.test(x)));
  assert.equal(t.rascunhos[0].extracao_status, 'parcial');
});

test('formato não suportado: pede reenvio', async () => {
  const t = montar({ extracao: { erro: 'formato_nao_suportado', sniffed: 'video/mp4' } });
  await foto(t);
  await esperar(() => perguntando(t) === 1);
  await texto(t, 'ATN');
  await esperar(() => cliente(t.enviados).some(x => /reenvie em formato JPG, PNG ou PDF/.test(x)));
});

test('depois do corte da viagem a foto não vira nota', async () => {
  const t = montar({
    extracao: LEU_TUDO,
    viagem: { id: 1, status: 'em_andamento', data_saida: data(-10), data_retorno: data(-3) },
  });
  await foto(t);
  assert.match(cliente(t.enviados)[0], /não estamos mais aceitando notas/);
  assert.equal(t.rascunhos.length, 0);
});

test('cliente esperando etiqueta: a foto não é tratada como nota', async () => {
  const t = montar({ extracao: LEU_TUDO, pedidosAtivos: [{ id: 9, status: 'aguardando_etiqueta' }] });
  await foto(t);
  assert.equal(t.rascunhos.length, 0);
  assert.ok(!cliente(t.enviados).some(x => /Recebi sua nota/.test(x)));
});

test('menu opção 1 pede só a foto; o resto o bot lê da nota', async () => {
  const t = montar({ extracao: LEU_TUDO });
  await texto(t, '1');
  assert.match(cliente(t.enviados)[0], /Pode enviar a foto, print ou PDF/);
  assert.equal(t.conversa().estado, 'flow1_notas');
  await foto(t);
  await esperar(() => t.rascunhos.length === 1);
  assert.equal(t.rascunhos[0].nome_loja, 'ATN');
});

test('PRONTO sem notas só cancela; texto solto lembra de mandar a foto', async () => {
  const t = montar({ extracao: LEU_TUDO });
  await texto(t, '1');
  await texto(t, 'oi?');
  assert.match(cliente(t.enviados).at(-1), /envie a foto, print ou PDF/);
  await texto(t, 'pronto');
  assert.match(cliente(t.enviados).at(-1), /Tudo bem/);
  assert.equal(t.conversa(), null);
});

test('cliente some sem responder: as notas pendentes não se perdem, vão para conferência', async () => {
  const t = montar({ extracao: NADA, idadeConversaMs: 20 * 60 * 1000 });
  await Promise.all([foto(t, 1), foto(t, 2)]);
  await esperar(() => perguntando(t) === 1);
  t.enviados.length = 0;
  await texto(t, 'oi'); // 20 minutos depois: a conversa expirou
  await esperar(() => t.rascunhos.length === 2);
  assert.deepEqual(t.rascunhos.map(r => r.nome_loja), ['', '']);
  assert.ok(cliente(t.enviados).some(x => /nossa equipe vai conferir/.test(x)));
  assert.ok(t.enviados.some(([p, x]) => p === OPERADOR && /não informada/.test(x)));
});

// ── cumprimento ──────────────────────────────────────────────────────────────

test('"oi" de cliente cadastrado: convida a enviar a nota, sem o menu', async () => {
  for (const saudacao of ['oi', 'Oi!', 'oiiii', 'Olá', 'bom dia', 'Boa tarde!', 'ola, tudo bem?', 'e aí', 'Opa tudo bem']) {
    const t = montar({ extracao: LEU_TUDO });
    await texto(t, saudacao);
    const resposta = cliente(t.enviados).at(-1);
    assert.match(resposta, /Olá, Ana! 👋 Pode enviar sua nota fiscal por aqui \(foto, print ou PDF\)/, saudacao);
    assert.match(resposta, /digite \*menu\*/);
    assert.doesNotMatch(resposta, /1️⃣|Enviar nota fiscal|Ver status/, `${saudacao}: sem o menu`);
  }
});

test('depois do "oi", a foto da nota funciona normalmente', async () => {
  const t = montar({ extracao: LEU_TUDO });
  await texto(t, 'oi');
  await foto(t);
  await esperar(() => t.rascunhos.length === 1);
  assert.equal(t.rascunhos[0].nome_loja, 'ATN');
});

test('"menu" continua mostrando o menu; frases que não são só cumprimento seguem o fluxo normal', async () => {
  const t = montar({ extracao: LEU_TUDO });
  await texto(t, 'menu');
  assert.match(cliente(t.enviados).at(-1), /Enviar nota fiscal/);
  const t2 = montar({ extracao: LEU_TUDO });
  await texto(t2, 'oi, quanto eu devo?');
  assert.doesNotMatch(cliente(t2.enviados).at(-1) || '', /Pode enviar sua nota fiscal por aqui/);
});

test('"oi" depois do corte da viagem avisa que não aceita mais notas', async () => {
  const t = montar({
    extracao: LEU_TUDO,
    viagem: { id: 1, status: 'em_andamento', data_saida: data(-10), data_retorno: data(-3) },
  });
  await texto(t, 'oi');
  const resposta = cliente(t.enviados).at(-1);
  assert.match(resposta, /Olá, Ana! 👋 No momento não estamos mais aceitando notas/);
  assert.doesNotMatch(resposta, /Pode enviar sua nota/);
});

test('"oi" com etiqueta pendente mantém o comportamento antigo (menu)', async () => {
  const t = montar({ extracao: LEU_TUDO, pedidosAtivos: [{ id: 9, status: 'aguardando_etiqueta' }] });
  await texto(t, 'oi');
  assert.doesNotMatch(cliente(t.enviados).at(-1) || '', /Pode enviar sua nota fiscal por aqui/);
});
