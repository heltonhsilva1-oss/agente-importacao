'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calcCorteDaViagem,
  calcUltimoCorte,
  dataReferenciaCicloViagem,
  viagemAceitaNotas,
  viagemPertenceAoCicloAtual,
} = require('../menu');

test('viagem sem corte definido permanece aberta até o fim do dia de retorno', () => {
  const viagem = {
    id: 9,
    status: 'em_andamento',
    data_saida: '2026-09-03',
    data_retorno: '2026-09-11',
  };
  const cfg = { horarioCorte: '17:00', diaCorte: 5 };

  assert.equal(calcCorteDaViagem(viagem, cfg.horarioCorte, cfg.diaCorte).toISOString(), '2026-09-11T20:00:00.000Z');
  assert.equal(viagemAceitaNotas(viagem, cfg, new Date('2026-09-08T15:00:00.000Z')), true);
  // sem corte definido na viagem vale a data de retorno informada (até o fim do dia)
  assert.equal(viagemAceitaNotas(viagem, cfg, new Date('2026-09-11T20:00:01.000Z')), true);
  assert.equal(viagemAceitaNotas(viagem, cfg, new Date('2026-09-12T03:00:00.000Z')), false);
});

test('retorno no sábado usa o corte configurado da sexta-feira anterior', () => {
  const viagem = {
    status: 'em_andamento',
    data_saida: '2026-08-25',
    data_retorno: '2026-08-29',
  };
  const cfg = { horarioCorte: '17:00', diaCorte: 5 };

  assert.equal(calcCorteDaViagem(viagem, cfg.horarioCorte, cfg.diaCorte).toISOString(), '2026-08-28T20:00:00.000Z');
});

test('viagem concluída não aceita novas notas', () => {
  const viagem = {
    status: 'concluida',
    data_saida: '2026-09-03',
    data_retorno: '2026-09-11',
  };

  assert.equal(viagemAceitaNotas(viagem, { horarioCorte: '17:00', diaCorte: 5 }), false);
});

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
