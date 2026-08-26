'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calcUltimoCorte,
  dataReferenciaCicloViagem,
  viagemPertenceAoCicloAtual,
} = require('../menu');

test('viagem criada antecipadamente usa data de saída para respeitar o corte configurado', () => {
  const viagem = {
    id: 8,
    criado_em: '2026-08-19T12:08:30.245Z',
    data_saida: '2026-08-25',
  };
  const agora = new Date('2026-08-26T14:00:00.000Z');
  const ultimoCorte = calcUltimoCorte('12:00', 5, agora);

  assert.equal(ultimoCorte.toISOString(), '2026-08-21T15:00:00.000Z');
  assert.equal(dataReferenciaCicloViagem(viagem).toISOString(), '2026-08-25T03:00:00.000Z');
  assert.equal(viagemPertenceAoCicloAtual(viagem, ultimoCorte), true);
});

test('a mesma viagem fecha depois do próximo corte configurado', () => {
  const viagem = {
    criado_em: '2026-08-19T12:08:30.245Z',
    data_saida: '2026-08-25',
  };
  const depoisDoCorte = new Date('2026-08-28T16:00:00.000Z');
  const ultimoCorte = calcUltimoCorte('12:00', 5, depoisDoCorte);

  assert.equal(ultimoCorte.toISOString(), '2026-08-28T15:00:00.000Z');
  assert.equal(viagemPertenceAoCicloAtual(viagem, ultimoCorte), false);
});

test('criado_em fica apenas como compatibilidade quando data_saida não existe', () => {
  const ultimoCorte = new Date('2026-08-21T15:00:00.000Z');

  assert.equal(viagemPertenceAoCicloAtual({ criado_em: '2026-08-22T12:00:00.000Z' }, ultimoCorte), true);
  assert.equal(viagemPertenceAoCicloAtual({ criado_em: '2026-08-19T12:00:00.000Z' }, ultimoCorte), false);
  assert.equal(viagemPertenceAoCicloAtual({}, ultimoCorte), true);
  assert.equal(viagemPertenceAoCicloAtual(null, ultimoCorte), false);
});
