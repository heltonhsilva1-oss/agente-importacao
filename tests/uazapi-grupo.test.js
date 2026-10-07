'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { updateGroupParticipants } = require('../uazapi');

test('remove participante usando o endpoint de grupos da UazAPI', async () => {
  const originalPost = axios.post;
  const originalUrl = process.env.UAZAPI_SERVER_URL;
  const originalToken = process.env.UAZAPI_INSTANCE_TOKEN;
  const calls = [];
  process.env.UAZAPI_SERVER_URL = 'https://uazapi.example';
  process.env.UAZAPI_INSTANCE_TOKEN = 'token';
  axios.post = async (...args) => { calls.push(args); return { data: { ok: true } }; };
  try {
    await updateGroupParticipants('120363123@g.us', 'remove', ['+55 (11) 99999-9999']);
    assert.equal(calls[0][0], 'https://uazapi.example/group/updateParticipants');
    assert.deepEqual(calls[0][1], {
      groupjid: '120363123@g.us', action: 'remove', participants: ['5511999999999'],
    });
    assert.equal(calls[0][2].headers.token, 'token');
  } finally {
    axios.post = originalPost;
    if (originalUrl === undefined) delete process.env.UAZAPI_SERVER_URL;
    else process.env.UAZAPI_SERVER_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UAZAPI_INSTANCE_TOKEN;
    else process.env.UAZAPI_INSTANCE_TOKEN = originalToken;
  }
});

test('recusa grupo sem JID e ação desconhecida', async () => {
  process.env.UAZAPI_SERVER_URL = 'https://uazapi.example';
  await assert.rejects(updateGroupParticipants('grupo-invalido', 'remove', ['5511']), /VIP_GROUP_JID/);
  await assert.rejects(updateGroupParticipants('120@g.us', 'ban', ['5511']), /Ação de grupo/);
});
