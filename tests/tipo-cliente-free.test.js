'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarBanco, carregarComStubs } = require('./helpers/fake-db');
const {
  variantesTelefone, chaveTelefone, extrairTelefonesParticipantes, classificarClientes, reincluirVipPago,
} = require('../tipo-cliente');
const { statusMensalidadeEfetivo } = require('../mensalidade');
const { enviarAvisosViagemFree, reenviarFalhasViagemFree } = require('../aviso-viagem-free');
const { montarPrevia, aplicarMigracao, alterarTipoCliente } = require('../migracao-tipo-cliente');
const { aplicarTotaisConfiaveis } = require('../financeiro-free');
const { getCobrancaPendente } = require('../pagamentos');
const { snapshotPedidoFree } = require('../tabela-free');
const { registrarTabelaFree } = require('../tabelas-free-store');

const silencio = { logger: { info() {}, warn() {}, error() {} } };

// ── telefones ────────────────────────────────────────────────────────────────

test('normaliza telefone com/sem 55 e com/sem nono dígito', () => {
  const k = chaveTelefone('(11) 99571-5042');
  assert.equal(k, '5511995715042');
  assert.equal(chaveTelefone('5511995715042'), k);
  assert.equal(chaveTelefone('551195715042'), k);
  assert.equal(chaveTelefone('11 9571-5042'), k);
  assert.deepEqual(variantesTelefone('5511995715042').sort(), ['551195715042', '5511995715042']);
  assert.equal(chaveTelefone('123'), null);
  assert.equal(chaveTelefone(''), null);
});

test('extrai telefones dos participantes e conta quem só tem LID', () => {
  const { telefones, semTelefone } = extrairTelefonesParticipantes([
    { PhoneNumber: '5511995715042@s.whatsapp.net' },
    { JID: '551188887777@s.whatsapp.net' },
    { JID: '99999999@lid' },
    '5521999990000@s.whatsapp.net',
  ]);
  assert.ok(telefones.has('5511995715042'));
  assert.ok(telefones.has('5511988887777'));
  assert.ok(telefones.has('5521999990000'));
  assert.equal(semTelefone, 1);
});

test('classifica VIP, Free e não identificados sem mexer em ninguém', () => {
  const grupo = new Set(['5511995715042']);
  const r = classificarClientes([
    { id: 1, nome: 'A', telefone: '11995715042' },
    { id: 2, nome: 'B', telefone: '11911112222' },
    { id: 3, nome: 'C', telefone: '' },
    { id: 4, nome: 'D', telefone: '11911113333', tipo_cliente: 'free' },
  ], grupo);
  assert.deepEqual(r.vip.map(c => c.id), [1]);
  assert.deepEqual(r.free.map(c => c.id), [2]);
  assert.deepEqual(r.naoIdentificados.map(c => c.id), [3]);
  assert.deepEqual(r.jaClassificados.map(c => c.id), [4]);
});

// ── migração ─────────────────────────────────────────────────────────────────

function bancoMigracao() {
  return criarBanco({
    'clientes/c1': { id: 1, nome: 'Vip Um', telefone: '11995715042', status_vip: 'removido_inadimplencia' },
    'clientes/c2': { id: 2, nome: 'Free Dois', telefone: '(11) 91111-2222' },
    'clientes/c3': { id: 3, nome: 'Sem Fone', telefone: '' },
  });
}
const grupoFalso = async () => ({ nome: 'Vip Kidex', participantes: [{ PhoneNumber: '551195715042@s.whatsapp.net' }] });

test('prévia da migração conta VIP, Free e não identificados sem gravar', async () => {
  const db = bancoMigracao();
  const p = await montarPrevia({ db, buscarGrupo: grupoFalso, jid: 'x@g.us' });
  assert.equal(p.totais.seriam_vip, 1);
  assert.equal(p.totais.seriam_free, 1);
  assert.equal(p.totais.nao_identificados, 1);
  assert.equal(db.docs.get('clientes/c1').tipo_cliente, undefined);
  assert.equal(db.docs.size, 3);
});

test('migração só aplica com o hash da prévia, é idempotente e audita', async () => {
  const db = bancoMigracao();
  await assert.rejects(aplicarMigracao({ db, hashConfirmado: 'errado', buscarGrupo: grupoFalso }), /prévia/i);
  const p = await montarPrevia({ db, buscarGrupo: grupoFalso });
  const r = await aplicarMigracao({ db, hashConfirmado: p.hash, buscarGrupo: grupoFalso, executadoPor: 'op@x.com' });
  assert.equal(r.aplicados, 2);
  assert.equal(db.docs.get('clientes/c1').tipo_cliente, 'vip');
  assert.equal(db.docs.get('clientes/c1').status_vip, 'ativo');
  assert.equal(db.docs.get('clientes/c2').tipo_cliente, 'free');
  assert.equal(db.docs.get('clientes/c3').tipo_cliente, undefined);
  const historico = [...db.docs.keys()].filter(k => k.startsWith('historico_tipo_cliente/'));
  assert.equal(historico.length, 2);
  assert.ok([...db.docs.keys()].some(k => k.startsWith('migracoes_tipo_cliente/')));

  const p2 = await montarPrevia({ db, buscarGrupo: grupoFalso });
  assert.equal(p2.totais.seriam_vip + p2.totais.seriam_free, 0);
  const r2 = await aplicarMigracao({ db, hashConfirmado: p2.hash, buscarGrupo: grupoFalso });
  assert.equal(r2.aplicados, 0);
});

test('grupo vazio aborta a migração: nunca classifica todos como Free', async () => {
  const db = bancoMigracao();
  await assert.rejects(montarPrevia({ db, buscarGrupo: async () => ({ participantes: [] }) }), /abortada/);
});

test('alteração manual só muda o cadastro depois de sincronizar o Grupo VIP', async () => {
  const db = criarBanco({
    'clientes/c1': { id: 1, nome: 'Cliente', telefone: '11995715042', tipo_cliente: 'free', status_vip: 'fora_grupo' },
  });
  const chamadas = [];
  const resultado = await alterarTipoCliente({
    db, clienteId: 1, para: 'vip', operacaoId: 'op-1', executadoPor: 'admin@x.com',
    atualizarGrupo: async (jid, acao, telefones) => chamadas.push([jid, acao, telefones]),
  });
  assert.equal(resultado.status, 'concluida');
  assert.equal(chamadas[0][1], 'add');
  assert.deepEqual(chamadas[0][2], ['5511995715042']);
  assert.equal(db.docs.get('clientes/c1').tipo_cliente, 'vip');
  assert.equal(db.docs.get('clientes/c1').status_vip, 'ativo');
  assert.ok([...db.docs.keys()].some(k => k.startsWith('historico_tipo_cliente/')));

  const repetida = await alterarTipoCliente({
    db, clienteId: 1, para: 'vip', operacaoId: 'op-1', atualizarGrupo: async () => { throw new Error('não deve chamar'); },
  });
  assert.equal(repetida.repetida, true);
});

test('falha da UAZAPI preserva o tipo anterior do cliente', async () => {
  const db = criarBanco({
    'clientes/c1': { id: 1, nome: 'Cliente', telefone: '11995715042', tipo_cliente: 'vip', status_vip: 'ativo' },
  });
  await assert.rejects(alterarTipoCliente({
    db, clienteId: 1, para: 'free', operacaoId: 'op-falha',
    atualizarGrupo: async () => { throw new Error('UAZAPI indisponível'); },
  }), /sincronizar/i);
  assert.equal(db.docs.get('clientes/c1').tipo_cliente, 'vip');
  assert.equal(db.docs.get('clientes/c1').status_vip, 'ativo');
  assert.equal(db.docs.get('alteracoes_tipo_cliente/op-falha').status, 'falha');
});

// ── mensalidade ──────────────────────────────────────────────────────────────

test('cliente Free nunca fica vencido nem entra em cobrança de mensalidade', () => {
  const free = { tipo_cliente: 'free', data_vencimento_mensalidade: 1, status_mensalidade: 'pendente' };
  assert.equal(statusMensalidadeEfetivo(free, { year: 2026, month: 10, day: 20 }), 'isento');
  const vip = { tipo_cliente: 'vip', data_vencimento_mensalidade: 1, status_mensalidade: 'pendente' };
  assert.equal(statusMensalidadeEfetivo(vip, { year: 2026, month: 10, day: 20 }), 'vencida');
});

function agendamentosComStubs(db, enviados, grupo = []) {
  const stubDb = { getFirestore: () => db, Timestamp: { now: () => new Date() }, FieldValue: { serverTimestamp: () => new Date() } };
  return carregarComStubs('agendamentos.js', {
    'firebase-admin/firestore': stubDb,
    './logger': silencio,
    './uazapi': {
      sendText: async (phone, msg) => { enviados.push([phone, msg]); },
      updateGroupParticipants: async (jid, acao, lista) => { grupo.push([acao, lista]); },
    },
    './firestore': {}, './portal-access': { buildPortalLink: () => 'x' }, './pagamentos': { getSaldoComissao: () => 0 },
    './mercadopago': { processOrderWebhook: async () => {}, vipChargeId: (a, b) => `vip_${a}_${b}` },
    'node-cron': { schedule() {} },
  });
}

test('rotinas de mensalidade ignoram Free e removem VIP inadimplente tornando-o Free', async () => {
  const db = criarBanco({
    'configuracoes/global': { valorMensalidadeVIP: 50 },
    'clientes/free': { id: 1, nome: 'Free', telefone: '11911112222', tipo_cliente: 'free', data_vencimento_mensalidade: 1, status_mensalidade: 'pendente' },
    'clientes/vip': { id: 2, nome: 'Vip', telefone: '11922223333', tipo_cliente: 'vip', data_vencimento_mensalidade: 1, status_mensalidade: 'pendente' },
  });
  const enviados = []; const grupo = [];
  const { jobAvisoVip, removerVipInadimplente } = agendamentosComStubs(db, enviados, grupo);
  await jobAvisoVip();
  assert.equal(enviados.filter(([p]) => p === '5511911112222').length, 0, 'Free não recebe aviso');

  await removerVipInadimplente({
    db, doc: { id: 'free', ref: db.collection('clientes').doc('free') }, cliente: db.docs.get('clientes/free'),
    phone: '5511911112222', dataHoje: '2026-10-20',
  });
  assert.equal(grupo.length, 0, 'Free nunca é removido pela rotina');

  await removerVipInadimplente({
    db, doc: { id: 'vip', ref: db.collection('clientes').doc('vip') },
    cliente: db.docs.get('clientes/vip'), phone: '5511922223333', dataHoje: '2026-10-20',
  });
  assert.deepEqual(grupo[0], ['remove', ['5511922223333']]);
  const vip = db.docs.get('clientes/vip');
  assert.equal(vip.tipo_cliente, 'free');
  assert.equal(vip.status_vip, 'removido_inadimplencia');
  assert.equal(statusMensalidadeEfetivo(vip, { year: 2026, month: 10, day: 25 }), 'isento');
  assert.ok([...db.docs.values()].some(d => d.motivo === 'remocao_inadimplencia' && d.para === 'free'));
});

test('pagamento com reinclusão no grupo volta o cliente para VIP ativo', async () => {
  const db = criarBanco({
    'clientes/x': { id: 9, nome: 'X', tipo_cliente: 'free', status_vip: 'removido_inadimplencia' },
  });
  const chamadas = [];
  const ok = await reincluirVipPago({
    db, clienteRef: db.collection('clientes').doc('x'), cliente: db.docs.get('clientes/x'),
    phone: '5511911112222', adicionarAoGrupo: async (...a) => chamadas.push(a),
  });
  assert.equal(ok, true);
  assert.equal(chamadas[0][1], 'add');
  assert.equal(db.docs.get('clientes/x').tipo_cliente, 'vip');
  assert.equal(db.docs.get('clientes/x').status_vip, 'ativo');

  const db2 = criarBanco({ 'clientes/y': { id: 10, tipo_cliente: 'free', status_vip: 'removido_inadimplencia' } });
  await assert.rejects(reincluirVipPago({
    db: db2, clienteRef: db2.collection('clientes').doc('y'), cliente: db2.docs.get('clientes/y'),
    phone: '55119', adicionarAoGrupo: async () => { throw new Error('uazapi fora'); },
  }));
  assert.equal(db2.docs.get('clientes/y').tipo_cliente, 'free');
});

// ── aviso de viagem ──────────────────────────────────────────────────────────

function bancoViagem() {
  return criarBanco({
    'clientes/a': { id: 1, nome: 'Ana', telefone: '11911110001', tipo_cliente: 'free' },
    'clientes/b': { id: 2, nome: 'Beto', telefone: '11911110002', tipo_cliente: 'free' },
    'clientes/c': { id: 3, nome: 'Caio', telefone: '11911110003', tipo_cliente: 'vip' },
    'clientes/d': { id: 4, nome: 'Duda', telefone: '11911110004', tipo_cliente: 'free', ativo: false },
    'viagens/7': { id: 7, status: 'em_andamento' },
  });
}
const viagem = { id: 7, status: 'em_andamento' };

test('aviso de viagem vai só aos Free ativos, sem cobrança nem propaganda do VIP', async () => {
  const db = bancoViagem(); const enviados = [];
  const r = await enviarAvisosViagemFree({ db, viagem, sendText: async (p, m) => { enviados.push([p, m]); } });
  assert.equal(r.enviados, 2);
  assert.deepEqual(enviados.map(e => e[0]).sort(), ['5511911110001', '5511911110002']);
  for (const [, msg] of enviados) {
    assert.match(msg, /nova viagem/i);
    assert.match(msg, /notas/i);
    assert.doesNotMatch(msg, /VIP|mensalidade|R\$|tabela|comiss/i);
  }
  assert.equal(db.docs.get('avisos_viagem_free/7_a').status, 'enviado');
});

test('repetir a operação (ou reiniciar) não duplica o aviso', async () => {
  const db = bancoViagem(); const enviados = [];
  const sendText = async (p) => { enviados.push(p); };
  await enviarAvisosViagemFree({ db, viagem, sendText });
  const r2 = await enviarAvisosViagemFree({ db, viagem, sendText });
  assert.equal(enviados.length, 2);
  assert.equal(r2.enviados, 0);
});

test('falha para um cliente não impede os demais e fica registrada com tentativas', async () => {
  const db = bancoViagem(); const enviados = [];
  const r = await enviarAvisosViagemFree({
    db, viagem,
    sendText: async (p) => { if (p.endsWith('0001')) throw new Error('timeout'); enviados.push(p); },
  });
  assert.equal(r.falhas, 1);
  assert.equal(r.enviados, 1);
  assert.deepEqual(enviados, ['5511911110002']);
  const falho = db.docs.get('avisos_viagem_free/7_a');
  assert.equal(falho.status, 'falha');
  assert.equal(falho.tentativas, 1);
  assert.match(falho.ultimo_erro, /timeout/);

  const reenviados = [];
  const r2 = await reenviarFalhasViagemFree({ db, sendText: async (p) => { reenviados.push(p); } });
  assert.equal(r2.enviados, 1);
  assert.deepEqual(reenviados, ['5511911110001']);
  assert.equal(db.docs.get('avisos_viagem_free/7_a').tentativas, 2);
  assert.equal(db.docs.get('avisos_viagem_free/7_a').status, 'enviado');
});

// ── validação financeira no backend ──────────────────────────────────────────

const pedidoFree = () => snapshotPedidoFree({
  id: 1, cliente_id: 1, viagem_id: 7, cotacao_dolar: 5, status: 'aguardando_pgto_travessia',
  produtos: [{ descricao: 'iPhone', quantidade: 2, valor_unitario_usd: 900, categoria_free: 'iphone_lacrado' }],
});

test('backend recalcula pedido Free e ignora totais adulterados', () => {
  const p = pedidoFree();
  assert.equal(p.total_comissao_brl, 700);
  const adulterado = { ...p, total_travessia_brl: 1, total_comissao_brl: 1 };
  const cobranca = getCobrancaPendente(adulterado);
  assert.equal(cobranca.tipo, 'travessia');
  assert.equal(cobranca.valor, 19.98);
  assert.equal(aplicarTotaisConfiaveis(adulterado).total_comissao_brl, 700);
});

test('pedido Free sem categoria válida não gera cobrança', () => {
  const p = pedidoFree();
  p.produtos[0] = {
    ...p.produtos[0], categoria_free: 'inexistente',
    taxa_snapshot: { ...p.produtos[0].taxa_snapshot, categoria_taxa: 'inexistente' },
  };
  assert.equal(getCobrancaPendente(p), null);
});

test('pedido VIP passa intacto pelo backend', () => {
  const vip = { id: 2, status: 'aguardando_pgto_travessia', total_travessia_brl: 33.3, total_comissao_brl: 80 };
  assert.equal(aplicarTotaisConfiaveis(vip), vip);
  assert.equal(getCobrancaPendente(vip).valor, 33.3);
});

test('backend aceita pedido de promoção (tabela editada) e barra valor adulterado', () => {
  const t2 = structuredClone(require('../tabela-free').TABELA_FREE_PADRAO);
  t2.versao = 'free_v2';
  t2.comissao_minima_unitaria = 5;
  t2.travessia_unitaria = 5;
  t2.categorias.iphone_lacrado.bandas[0].faixas[0].valor = 200;
  assert.equal(registrarTabelaFree(t2), true);
  const promo = snapshotPedidoFree({
    id: 3, cliente_id: 1, viagem_id: 7, cotacao_dolar: 5, status: 'aguardando_pgto_travessia',
    produtos: [{ descricao: 'iPhone', quantidade: 2, valor_unitario_usd: 900, categoria_free: 'iphone_lacrado' }],
  }, { tabela: t2 });
  assert.equal(promo.total_comissao_brl, 400);
  const c = getCobrancaPendente({ ...promo, total_travessia_brl: 1 });
  assert.equal(c.valor, 10); // 2 x R$ 5 da promoção
  const confiavel = aplicarTotaisConfiaveis({ ...promo, total_comissao_brl: 1 });
  assert.equal(confiavel.total_comissao_brl, 400);

  const adulterado = structuredClone(promo);
  adulterado.produtos[0].valor_unitario_usd = 1; // nota diz outro valor que o snapshot
  assert.equal(getCobrancaPendente(adulterado), null);
  const semSnapshot = structuredClone(promo);
  delete semSnapshot.produtos[0].taxa_snapshot;
  assert.equal(getCobrancaPendente(semSnapshot), null);
});
