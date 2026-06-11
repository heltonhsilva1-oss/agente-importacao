'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPERATOR_PHONE = '5511999999999';

const pendentes = [
  {
    id: 'a',
    pedido_id: 101,
    cliente_numero: '5511111111111',
    cliente_nome: 'Ana',
    tipo: 'travessia',
    valor: 120,
    status: 'aguardando',
  },
  {
    id: 'b',
    pedido_id: 202,
    cliente_numero: '5522222222222',
    cliente_nome: 'Bruno',
    tipo: 'comissao',
    valor: 50,
    status: 'aguardando',
  },
];

const mensagens = [];
const reservas = new Set();
const finalizados = [];
const confirmados = [];

const firestorePath = require.resolve('../firestore');
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    getConversa: async () => null,
    setConversa: async () => {},
    clearConversa: async () => {},
    findClienteByWhatsapp: async () => null,
    getClientesAtivos: async () => [],
    getPedidosAtivos: async () => [],
    getPedidosPendentes: async () => [],
    addPendentePagamento: async () => ({ id: 'x', criado: true }),
    getPendentesPagamento: async () =>
      pendentes.filter((p) => p.status === 'aguardando'),
    reservarPendente: async (id) => {
      const item = pendentes.find((p) => p.id === id);
      if (!item || item.status !== 'aguardando' || reservas.has(id)) return null;
      reservas.add(id);
      item.status = 'processando';
      return { ...item };
    },
    finalizarPendente: async (id, status) => {
      const item = pendentes.find((p) => p.id === id);
      item.status = status;
      finalizados.push([id, status]);
    },
    devolverPendenteFila: async () => {},
    confirmarPagamentoPedido: async (pedidoId, tipo) => {
      confirmados.push([pedidoId, tipo]);
      return { ok: true };
    },
    appendHistorico: async () => {},
    getHistorico: async () => [],
  },
};

const uazapiPath = require.resolve('../uazapi');
require.cache[uazapiPath] = {
  id: uazapiPath,
  filename: uazapiPath,
  loaded: true,
  exports: {
    sendText: async (phone, text) => mensagens.push([phone, text]),
  },
};

const claudePath = require.resolve('../claude');
require.cache[claudePath] = {
  id: claudePath,
  filename: claudePath,
  loaded: true,
  exports: {
    responder: async () => null,
    detectarIntencao: async () => 0,
  },
};

const { handleMessage, parseComandoFila, formatarFila } = require('../menu');

test('interpreta comandos simples e numerados', () => {
  assert.deepEqual(parseComandoFila('OK'), { acao: 'confirmar', posicao: 1 });
  assert.deepEqual(parseComandoFila('não 2'), { acao: 'recusar', posicao: 2 });
  assert.deepEqual(parseComandoFila('FILA'), { acao: 'listar', posicao: null });
  assert.equal(parseComandoFila('talvez'), null);
});

test('formata uma fila numerada compreensível', () => {
  const texto = formatarFila(pendentes);
  assert.match(texto, /1\. Pedido #101/);
  assert.match(texto, /2\. Pedido #202/);
  assert.match(texto, /OK 2 \/ NÃO 2/);
});

test('OK confirma o primeiro e NÃO 1 recusa o próximo', async () => {
  await handleMessage(process.env.OPERATOR_PHONE, 'text', 'OK');
  assert.deepEqual(confirmados, [[101, 'travessia']]);
  assert.deepEqual(finalizados[0], ['a', 'confirmado']);

  await handleMessage(process.env.OPERATOR_PHONE, 'text', 'NÃO 1');
  assert.deepEqual(finalizados[1], ['b', 'recusado']);
  assert.ok(mensagens.some(([, texto]) => texto.includes('pedido #101')));
  assert.ok(mensagens.some(([, texto]) => texto.includes('pedido #202')));
});

test('duas confirmações simultâneas não processam o mesmo item duas vezes', async () => {
  pendentes[0].status = 'aguardando';
  reservas.clear();
  confirmados.length = 0;

  await Promise.all([
    handleMessage(process.env.OPERATOR_PHONE, 'text', 'OK'),
    handleMessage(process.env.OPERATOR_PHONE, 'text', 'OK'),
  ]);

  assert.equal(confirmados.length, 1);
});
