'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { viagemAceitaNotas, avaliarJanelaNotas, escolherViagemParaNotas, janelaDeNotas } = require('../menu');

// Horário de Brasília = UTC-3
const sp = (iso) => new Date(`${iso}-03:00`);
const cfg = { horarioCorte: '11:00', diaCorte: 5 };

test('a janela é a que o operador definiu: abre na data/hora de abertura e fecha no corte', () => {
  const viagem = {
    id: 5, status: 'em_andamento', data_abertura: '2026-10-05', hora_abertura: '08:00',
    data_corte: '2026-10-10', hora_corte: '18:30', data_retorno: '2026-10-11',
  };
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-05T07:59:00')), false, 'ainda não abriu');
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-05T08:00:00')), true);
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-09T23:00:00')), true, 'passou da "sexta 11h" antiga e segue aberta');
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T18:30:00')), true, 'até o minuto do corte');
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T18:31:00')), false);
});

test('sábado é aceito quando o operador coloca o corte no sábado', () => {
  const viagem = { id: 6, status: 'em_andamento', data_corte: '2026-10-10', hora_corte: '12:00', data_retorno: '2026-10-10' };
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T09:00:00')), true);
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-10T12:01:00')), false);
});

test('sem hora de corte na viagem usa a hora padrão de Configurações; sem abertura abre logo', () => {
  const viagem = { id: 7, status: 'em_andamento', data_corte: '2026-10-10' };
  assert.equal(janelaDeNotas(viagem, { horarioCorte: '17:00' }).corte.toISOString(), '2026-10-10T20:00:00.000Z');
  assert.equal(janelaDeNotas(viagem, {}).corte.toISOString(), '2026-10-11T02:59:00.000Z'); // 23:59
  assert.equal(viagemAceitaNotas(viagem, { horarioCorte: '17:00' }, sp('2026-10-01T10:00:00')), true);
});

test('viagem concluída nunca aceita, mesmo dentro da janela', () => {
  const viagem = { id: 8, status: 'concluida', data_corte: '2026-12-31' };
  assert.equal(viagemAceitaNotas(viagem, cfg, sp('2026-10-01T10:00:00')), false);
});

test('viagem antiga sem data de corte continua usando a regra anterior', () => {
  const viagem = { id: 9, status: 'em_andamento', data_saida: '2026-09-03', data_retorno: '2026-09-11' };
  assert.equal(viagemAceitaNotas(viagem, { horarioCorte: '17:00', diaCorte: 5 }, sp('2026-09-08T12:00:00')), true);
  assert.equal(viagemAceitaNotas(viagem, { horarioCorte: '17:00', diaCorte: 5 }, sp('2026-09-11T17:01:00')), false);
});

test('mensagens dizem o motivo exato (abre em / corte foi em / sem viagem)', () => {
  const viagem = {
    id: 5, status: 'em_andamento', data_abertura: '2026-10-05', hora_abertura: '08:00',
    data_corte: '2026-10-10', hora_corte: '18:30',
  };
  assert.match(avaliarJanelaNotas([viagem], cfg, sp('2026-10-04T10:00:00')).mensagem, /abre para notas em 05\/10 às 08:00/);
  assert.match(avaliarJanelaNotas([viagem], cfg, sp('2026-10-11T10:00:00')).mensagem, /O corte desta viagem foi em 10\/10 às 18:30/);
  assert.equal(avaliarJanelaNotas([viagem], cfg, sp('2026-10-07T10:00:00')).aceita, true);
  assert.match(avaliarJanelaNotas([], cfg).mensagem, /não há viagem aberta/);
  assert.match(avaliarJanelaNotas([{ id: 1, status: 'concluida' }], cfg).mensagem, /não há viagem aberta/);
});

test('com várias viagens em andamento vale a que está dentro da janela; senão a de maior número', () => {
  const velha = { id: 3, status: 'em_andamento', data_corte: '2026-10-20' };
  const nova = { id: 4, status: 'em_andamento', data_abertura: '2026-10-15', data_corte: '2026-10-25' };
  assert.equal(escolherViagemParaNotas([velha, nova], cfg, sp('2026-10-08T10:00:00')).id, 3, 'a nova ainda não abriu');
  assert.equal(escolherViagemParaNotas([velha, nova], cfg, sp('2026-10-16T10:00:00')).id, 4);
  assert.equal(escolherViagemParaNotas([velha, nova], cfg, sp('2026-11-01T10:00:00')).id, 4, 'nenhuma aceita: explica pela mais recente');
  // viagem concluída com número maior não esconde a que está em andamento
  assert.equal(escolherViagemParaNotas([velha, { id: 9, status: 'concluida' }], cfg, sp('2026-10-08T10:00:00')).id, 3);
});
