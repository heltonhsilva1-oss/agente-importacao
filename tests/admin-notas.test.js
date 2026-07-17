'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getBearerToken, sniffType, selecionarMensagemNota } = require('../admin-notas');

test('extrai somente token Bearer válido', () => {
  assert.equal(getBearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(getBearerToken('bearer token'), 'token');
  assert.equal(getBearerToken('Basic token'), '');
});

test('reconhece os formatos permitidos das notas', () => {
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(sniffType(Buffer.from('%PDF-1.7')), 'application/pdf');
  assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
});

test('associa nota antiga pela URL exata da mensagem', () => {
  const origem = 'https://cdn.whatsapp.net/nota-antiga.enc';
  const resultado = selecionarMensagemNota([
    {
      messageid: 'outra',
      fromMe: false,
      messageType: 'imageMessage',
      messageTimestamp: 1700000000000,
      content: { url: 'https://cdn.whatsapp.net/outra.enc' },
    },
    {
      messageid: 'correta',
      fromMe: false,
      messageType: 'imageMessage',
      messageTimestamp: 1700000010000,
      content: { url: origem },
    },
  ], { origem, criadoEm: 1700000000000 });

  assert.equal(resultado.mensagem.messageid, 'correta');
  assert.equal(resultado.criterio, 'url_exata');
});

test('associa por horário somente quando existe uma única mídia próxima', () => {
  const resultado = selecionarMensagemNota([
    {
      messageid: 'correta',
      fromMe: false,
      messageType: 'documentMessage',
      messageTimestamp: 1700000020000,
    },
    {
      messageid: 'distante',
      fromMe: false,
      messageType: 'imageMessage',
      messageTimestamp: 1700000300000,
    },
    {
      messageid: 'enviada-pelo-bot',
      fromMe: true,
      messageType: 'imageMessage',
      messageTimestamp: 1700000021000,
    },
  ], { criadoEm: 1700000025000 });

  assert.equal(resultado.mensagem.messageid, 'correta');
  assert.equal(resultado.criterio, 'horario_unico');
});

test('não arrisca associação quando duas mídias estão próximas', () => {
  const resultado = selecionarMensagemNota([
    {
      messageid: 'uma',
      fromMe: false,
      messageType: 'imageMessage',
      messageTimestamp: 1700000010000,
    },
    {
      messageid: 'duas',
      fromMe: false,
      messageType: 'imageMessage',
      messageTimestamp: 1700000020000,
    },
  ], { criadoEm: 1700000015000 });

  assert.equal(resultado, null);
});
