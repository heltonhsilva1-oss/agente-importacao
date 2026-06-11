'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const mensagens = [];
const processadas = new Set();
const menuPath = require.resolve('../menu');
require.cache[menuPath] = {
  id: menuPath,
  filename: menuPath,
  loaded: true,
  exports: {
    handleMessage: async (...args) => mensagens.push(args),
  },
};

const firestorePath = require.resolve('../firestore');
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    claimWebhookMessage: async (key) => {
      if (!key) return true;
      if (processadas.has(key)) return false;
      processadas.add(key);
      return true;
    },
    completeWebhookMessage: async () => {},
    releaseWebhookMessage: async (key) => processadas.delete(key),
  },
};

const {
  setupWebhook,
  isSecretConfigured,
  isValidSecret,
  messageKey,
} = require('../webhook');

const SEGREDO_VALIDO = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

async function iniciarServidor(secret) {
  process.env.WEBHOOK_PATH_SECRET = secret;
  const app = express();
  app.use(express.json());
  setupWebhook(app);

  const server = await new Promise((resolve) => {
    const aberto = app.listen(0, '127.0.0.1', () => resolve(aberto));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) =>
      server.close((err) => err ? reject(err) : resolve())
    ),
  };
}

test('compara o segredo sem aceitar vazio ou tamanho diferente', () => {
  assert.equal(isSecretConfigured(SEGREDO_VALIDO), true);
  assert.equal(isSecretConfigured('segredo-curto'), false);
  assert.equal(isValidSecret(SEGREDO_VALIDO, SEGREDO_VALIDO), true);
  assert.equal(isValidSecret(`${SEGREDO_VALIDO}a`, SEGREDO_VALIDO), false);
  assert.equal(isValidSecret('segredo-curto', 'segredo-curto'), false);
  assert.equal(isValidSecret('', ''), false);
});

test('gera chave de deduplicação estável sem usar o ID como caminho', () => {
  assert.equal(messageKey('mensagem/123'), messageKey('mensagem/123'));
  assert.match(messageKey('mensagem/123'), /^[a-f0-9]{64}$/);
  assert.equal(messageKey(''), '');
});

test('recusa webhook sem segredo no caminho', async () => {
  const servidor = await iniciarServidor(SEGREDO_VALIDO);
  try {
    const resposta = await fetch(`${servidor.url}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '5511999999999', body: 'oi', id: 'sem-segredo' }),
    });
    assert.equal(resposta.status, 401);
  } finally {
    await servidor.close();
  }
});

test('recusa segredo errado e não processa a mensagem', async () => {
  mensagens.length = 0;
  const servidor = await iniciarServidor(SEGREDO_VALIDO);
  try {
    const resposta = await fetch(`${servidor.url}/webhook/segredo-errado`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '5511999999999', body: 'oi', id: 'errado' }),
    });
    assert.equal(resposta.status, 401);
    assert.equal(mensagens.length, 0);
  } finally {
    await servidor.close();
  }
});

test('aceita segredo correto e processa a mensagem', async () => {
  mensagens.length = 0;
  processadas.clear();
  const servidor = await iniciarServidor(SEGREDO_VALIDO);
  try {
    const resposta = await fetch(`${servidor.url}/webhook/${SEGREDO_VALIDO}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: '5511888888888',
        body: 'menu',
        type: 'text',
        id: 'correto',
      }),
    });
    assert.equal(resposta.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mensagens.length, 1);
    assert.equal(mensagens[0][0], '5511888888888');
  } finally {
    await servidor.close();
  }
});

test('ignora reenvio com o mesmo ID mesmo após nova requisição', async () => {
  mensagens.length = 0;
  processadas.clear();
  const servidor = await iniciarServidor(SEGREDO_VALIDO);
  const payload = {
    phone: '5511888888888',
    body: 'menu',
    type: 'text',
    id: 'duplicada-persistente',
  };
  try {
    for (let i = 0; i < 2; i++) {
      const resposta = await fetch(`${servidor.url}/webhook/${SEGREDO_VALIDO}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(resposta.status, 200);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(mensagens.length, 1);
  } finally {
    await servidor.close();
  }
});

test('sem configuração retorna indisponível e health informa proteção desativada', async () => {
  const servidor = await iniciarServidor('');
  try {
    const resposta = await fetch(`${servidor.url}/webhook/qualquer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(resposta.status, 503);

    const health = await fetch(`${servidor.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).webhookProtected, false);
  } finally {
    await servidor.close();
  }
});
