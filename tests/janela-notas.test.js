'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { viagemAceitaNotas, avaliarJanelaNotas, escolherViagemParaNotas, corteDaViagem } = require('../menu');

// Horário de Brasília = UTC-3
const sp = (iso) => new Date(`${iso}-03:00`);
const cfg = { horarioCorte: '11:00', diaCorte: 5 };

test('uma regra só: viagem em andamento recebe notas desde a criação até o corte (data e hora)', () => {
  const viagem = { id: 5, status: 'em_andamento', data_saida: '2026-10-10', data_corte: '2026-10-12', hora_corte: '18:30', data_retorno: '2026-10-14' };
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-01T09:00:00')), true, 'já aceita desde que foi criada');
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-09T23:00:00')), true, 'a "sexta 11h" antiga não fecha mais');
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-12T18:30:00')), true, 'até o minuto do corte');
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-12T18:31:00')), false);
});

test('campos de abertura antigos são ignorados (não existe segunda regra)', () => {
  const viagem = { id: 5, status: 'em_andamento', data_abertura: '2026-10-20', hora_abertura: '08:00', data_corte: '2026-10-25' };
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T09:00:00')), true);
});

test('sábado é aceito quando o operador coloca o corte no sábado', () => {
  const viagem = { id: 6, status: 'em_andamento', data_corte: '2026-10-10', hora_corte: '12:00', data_retorno: '2026-10-10' };
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T09:00:00')), true);
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T12:01:00')), false);
});

test('sem hora de corte na viagem usa a hora padrão de Configurações', () => {
  const viagem = { id: 7, status: 'em_andamento', data_corte: '2026-10-10' };
  assert.equal(corteDaViagem(viagem, { horarioCorte: '17:00' }).toISOString(), '2026-10-10T20:00:00.000Z');
  assert.equal(corteDaViagem(viagem, {}).toISOString(), '2026-10-11T02:59:00.000Z'); // 23:59
  assert.equal(corteDaViagem({ id: 8 }, cfg), null);
});

test('viagem concluída nunca aceita, mesmo antes do corte', () => {
  assert.equal(viagemAceitaNotas({ id: 8, status: 'concluida', data_corte: '2026-12-31' }, cfg, sp('2026-10-01T10:00:00')), false);
});

test('viagem sem data de corte: vale a data de retorno informada, sem regra de sexta', () => {
  const viagem = { id: 9, status: 'em_andamento', data_saida: '2026-10-05', data_retorno: '2026-10-10' };
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-09T15:00:00')), true, 'sexta à tarde');
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T09:00:00')), true, 'sábado de manhã');
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T23:59:30')), true);
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-11T00:00:01')), false, 'só depois do dia de retorno');
  assert.match(avaliarJanelaNotas([viagem], cfg, sp('2026-10-11T10:00:00')).mensagem, /terminou em 10\/10/);
  assert.equal(viagemAceitaNotas({ id: 10, status: 'em_andamento' }, cfg, sp('2026-10-20T10:00:00')), true);
});

test('mensagens dizem o motivo exato (corte foi em / sem viagem)', () => {
  const viagem = { id: 5, status: 'em_andamento', data_corte: '2026-10-10', hora_corte: '18:30' };
  assert.equal(avaliarJanelaNotas([viagem], cfg, sp('2026-10-07T10:00:00')).aceita, true);
  assert.match(avaliarJanelaNotas([viagem], cfg, sp('2026-10-11T10:00:00')).mensagem, /O corte desta viagem foi em 10\/10 às 18:30/);
  assert.match(avaliarJanelaNotas([], cfg).mensagem, /não há viagem aberta/);
  assert.match(avaliarJanelaNotas([{ id: 1, status: 'concluida' }], cfg).mensagem, /não há viagem aberta/);
});

test('com várias viagens em andamento vale a que ainda está no prazo; senão a de maior número', () => {
  const velha = { id: 3, status: 'em_andamento', data_corte: '2026-10-20' };
  const nova = { id: 4, status: 'em_andamento', data_corte: '2026-10-25' };
  assert.equal(escolherViagemParaNotas([velha, nova], cfg, sp('2026-10-08T10:00:00')).id, 4, 'a mais nova primeiro');
  assert.equal(escolherViagemParaNotas([velha, nova], cfg, sp('2026-10-22T10:00:00')).id, 4);
  assert.equal(escolherViagemParaNotas([velha, nova], cfg, sp('2026-11-01T10:00:00')).id, 4, 'nenhuma aceita: explica pela mais recente');
  assert.equal(escolherViagemParaNotas([velha, { id: 9, status: 'concluida' }], cfg, sp('2026-10-08T10:00:00')).id, 3);
});
