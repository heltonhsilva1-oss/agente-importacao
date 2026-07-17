'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getBearerToken, sniffType } = require('../admin-notas');

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
