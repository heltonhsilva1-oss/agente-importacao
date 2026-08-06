'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { padronizarNomeLoja } = require('../lojas');

test('bot salva os nomes oficiais definidos para as lojas', () => {
  assert.equal(padronizarNomeLoja('atn'), 'ATN');
  assert.equal(padronizarNomeLoja('STAR'), 'Star Company');
  assert.equal(padronizarNomeLoja('star company'), 'Star Company');
  assert.equal(padronizarNomeLoja('prime'), 'PRIMESHOP');
  assert.equal(padronizarNomeLoja('Prime Shop'), 'PRIMESHOP');
});

test('bot usa as lojas parametrizadas no Firestore', () => {
  const regras = [{ id: 'cell-shop', nomeOficial: 'Cell Shop', aliases: ['cell', 'CellShop'] }];
  assert.equal(padronizarNomeLoja('cell', regras), 'Cell Shop');
  assert.equal(padronizarNomeLoja('CellShop', regras), 'Cell Shop');
});
