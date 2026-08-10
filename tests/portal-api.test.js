'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const SEGREDO = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
process.env.PORTAL_LINK_SECRET = SEGREDO;

const data = {
  clientes: [
    {
      id: 1,
      nome: 'Cliente Um',
      cpf: '111.222.333-44',
      telefone: '(11) 98888-1234',
      ativo: true,
    },
    {
      id: 2,
      nome: 'Cliente Dois',
      cpf: '999.888.777-66',
      telefone: '(11) 97777-5678',
      ativo: true,
    },
  ],
  pedidos: [
    { id: 10, cliente_id: 1, nome_loja: 'Loja Um', status: 'em_transito', segredo_interno: 'x' },
    { id: 20, cliente_id: 2, nome_loja: 'Loja Dois', status: 'postado' },
  ],
  categorias: [{ id: 1, nome: 'Eletrônicos', tipo: 'percentual', valor: 0.1 }],
  separacoes_clientes: [
    {
      separacao_id: 'viagem_7__cliente_1', cliente_id: '1', viagem_id: '7', status: 'concluida',
      pedido_ids: ['10'], lojas: ['Loja Um'], total_esperado: 3,
      foto_final: { url: 'https://storage.example/foto-cliente-1.jpg', path: 'privado/1.jpg', name: 'foto.jpg', type: 'image/jpeg' },
      finalizado_por: 'admin-secreto',
    },
    {
      separacao_id: 'viagem_7__cliente_2', cliente_id: '2', viagem_id: '7', status: 'concluida',
      pedido_ids: ['20'], lojas: ['Loja Dois'], total_esperado: 1,
      foto_final: { url: 'https://storage.example/foto-cliente-2.jpg', path: 'privado/2.jpg' },
    },
    {
      separacao_id: 'rascunho-cliente-1', cliente_id: '1', viagem_id: '8', status: 'em_andamento',
      pedido_ids: ['10'], foto_final: { url: 'https://storage.example/rascunho.jpg' },
    },
  ],
};

const firestoreModule = require.resolve('firebase-admin/firestore');
const originalFirestore = require(firestoreModule);
require.cache[firestoreModule].exports = {
  ...originalFirestore,
  getFirestore: () => ({
    collection: (name) => ({
      get: async () => ({
        docs: (data[name] || []).map((item, index) => ({
          id: String(index + 1),
          data: () => item,
        })),
      }),
    }),
  }),
};

const { setupPortal } = require('../portal');
const { buildPortalLink, signPortalPhone } = require('../portal-access');

async function iniciarServidor() {
  const app = express();
  app.use(express.json());
  setupPortal(app);
  const server = await new Promise((resolve) => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) =>
      server.close((err) => err ? reject(err) : resolve())
    ),
  };
}

test('CPF e quatro dígitos retornam somente os dados daquele cliente', async () => {
  const server = await iniciarServidor();
  try {
    const response = await fetch(`${server.url}/portal-api/acesso`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ cpf: '11122233344', ultimosDigitos: '1234' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.cliente.nome, 'Cliente Um');
    assert.equal(body.cliente.cpf, undefined);
    assert.equal(body.cliente.telefone, undefined);
    assert.deepEqual(body.pedidos.map((p) => p.id), [10]);
    assert.equal(body.pedidos[0].segredo_interno, undefined);
    assert.equal(body.separacoes.length, 1);
    assert.equal(body.separacoes[0].id, 'viagem_7__cliente_1');
    assert.equal(body.separacoes[0].foto.url, 'https://storage.example/foto-cliente-1.jpg');
    assert.equal(body.separacoes[0].foto.path, undefined);
    assert.equal(body.separacoes[0].finalizado_por, undefined);
  } finally {
    await server.close();
  }
});

test('link assinado mantém acesso direto por telefone', async () => {
  const server = await iniciarServidor();
  try {
    const tel = '5511988881234';
    const response = await fetch(`${server.url}/portal-api/acesso`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ tel, acesso: signPortalPhone(tel) }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cliente.id, 1);
  } finally {
    await server.close();
  }
});

test('gerador preserva o parâmetro tel e inclui assinatura', () => {
  const link = new URL(buildPortalLink('https://kidex.example/portal', '5511988881234'));
  assert.equal(link.searchParams.get('tel'), '5511988881234');
  assert.equal(link.searchParams.get('acesso'), signPortalPhone('5511988881234'));
});

test('telefone sem assinatura ou assinatura falsa é recusado', async () => {
  const server = await iniciarServidor();
  try {
    const response = await fetch(`${server.url}/portal-api/acesso`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ tel: '5511988881234', acesso: 'falso' }),
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('origem não autorizada é recusada', async () => {
  const server = await iniciarServidor();
  try {
    const response = await fetch(`${server.url}/portal-api/acesso`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://site-malicioso.example',
      },
      body: JSON.stringify({ cpf: '11122233344', ultimosDigitos: '1234' }),
    });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});
