'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getQueueFailureState,
} = require('../firestore');

test('fila agenda nova tentativa antes do limite', () => {
  assert.deepEqual(getQueueFailureState(0), { attempts: 1, permanent: false });
  assert.deepEqual(getQueueFailureState(3), { attempts: 4, permanent: false });
});

test('fila encerra após cinco falhas', () => {
  assert.deepEqual(getQueueFailureState(4), { attempts: 5, permanent: true });
  assert.deepEqual(getQueueFailureState(7), { attempts: 8, permanent: true });
});
