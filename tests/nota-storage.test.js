'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getBucketName, safePart } = require('../nota-storage');

test('normaliza cliente e loja para nomes seguros no Storage', () => {
  assert.equal(safePart('Lucas Perpétuo / Loja A'), 'Lucas_Perpetuo_Loja_A');
  assert.equal(safePart('', 'cliente'), 'cliente');
});

test('usa o bucket do projeto quando não há variável específica', () => {
  const anterior = process.env.FIREBASE_STORAGE_BUCKET;
  delete process.env.FIREBASE_STORAGE_BUCKET;
  assert.equal(getBucketName(), 'minhaimportacao-5442a.firebasestorage.app');
  if (anterior === undefined) delete process.env.FIREBASE_STORAGE_BUCKET;
  else process.env.FIREBASE_STORAGE_BUCKET = anterior;
});
