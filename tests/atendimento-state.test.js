'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { estadoExpiraPorInatividade } = require('../menu');

test('espera por etiqueta expira para não capturar uma nota enviada dias depois', () => {
  assert.equal(estadoExpiraPorInatividade('flow4_etiqueta'), true);
});

test('fluxos ativos de nota continuam sujeitos ao timeout normal', () => {
  assert.equal(estadoExpiraPorInatividade('flow1_loja'), true);
  assert.equal(estadoExpiraPorInatividade('flow1_vendedor'), true);
  assert.equal(estadoExpiraPorInatividade('flow1_arquivo'), true);
});

test('menu e estado ocioso não geram aviso de sessão expirada', () => {
  assert.equal(estadoExpiraPorInatividade('idle'), false);
  assert.equal(estadoExpiraPorInatividade('menu'), false);
});
