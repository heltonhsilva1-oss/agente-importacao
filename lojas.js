'use strict';

const ALIASES_LOJAS = new Map([
  ['atn', 'ATN'],
  ['star', 'Star Company'],
  ['star company', 'Star Company'],
  ['starcompany', 'Star Company'],
  ['prime', 'PRIMESHOP'],
  ['prime shop', 'PRIMESHOP'],
  ['primeshop', 'PRIMESHOP'],
]);

function chaveLoja(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function padronizarNomeLoja(value) {
  const nome = String(value || '').replace(/\s+/g, ' ').trim();
  if (!nome) return '';
  const chave = chaveLoja(nome);
  return ALIASES_LOJAS.get(chave) || ALIASES_LOJAS.get(chave.replace(/\s/g, '')) || nome;
}

module.exports = { chaveLoja, padronizarNomeLoja };
