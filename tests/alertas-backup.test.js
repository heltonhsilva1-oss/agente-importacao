'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { alertarFalha, protegerRotina, limparAvisos } = require('../alertas');
const { executarBackup, limparBackupsAntigos, COLECOES } = require('../backup');
const { criarBanco } = require('./helpers/fake-db');

test('falha de rotina avisa o operador uma vez por janela e nunca propaga', async () => {
  limparAvisos();
  const enviados = [];
  const enviar = async (phone, texto) => { enviados.push([phone, texto]); };
  const rotina = protegerRotina('jobTeste', async () => { throw new Error('boom'); }, { enviar, agora: 1000 });
  assert.equal(await rotina(), undefined); // não lança
  assert.equal(enviados.length, 1);
  assert.match(enviados[0][1], /jobTeste/);
  assert.match(enviados[0][1], /boom/);

  await protegerRotina('jobTeste', async () => { throw new Error('de novo'); }, { enviar, agora: 2000 })();
  assert.equal(enviados.length, 1, 'repetição dentro de 6 h não reenvia');
  await protegerRotina('jobTeste', async () => { throw new Error('depois'); }, { enviar, agora: 1000 + 7 * 3600 * 1000 })();
  assert.equal(enviados.length, 2, 'depois da janela volta a avisar');
  await protegerRotina('outraRotina', async () => { throw new Error('x'); }, { enviar, agora: 3000 })();
  assert.equal(enviados.length, 3, 'rotinas diferentes têm avisos independentes');
});

test('se o próprio aviso falha, não derruba o agente', async () => {
  limparAvisos();
  const ok = await alertarFalha('rotinaX', new Error('falha'), { enviar: async () => { throw new Error('whatsapp fora'); } });
  assert.equal(ok, false);
});

test('rotina que funciona devolve o resultado e não avisa', async () => {
  limparAvisos();
  const enviados = [];
  const r = await protegerRotina('ok', async () => 42, { enviar: async () => enviados.push(1) })();
  assert.equal(r, 42);
  assert.equal(enviados.length, 0);
});

function bucketFalso() {
  const arquivos = new Map();
  return {
    arquivos,
    file: nome => ({
      name: nome,
      save: async conteudo => { arquivos.set(nome, conteudo); },
      delete: async () => { arquivos.delete(nome); },
    }),
    getFiles: async ({ prefix }) => [[...arquivos.keys()].filter(n => n.startsWith(prefix)).map(n => ({
      name: n, delete: async () => { arquivos.delete(n); },
    }))],
  };
}

test('backup grava um JSON por coleção, com resumo, convertendo timestamps', async () => {
  const db = criarBanco({
    'clientes/a': { id: 1, nome: 'Ana', criado: { _seconds: 1767323045, _nanoseconds: 0 } },
    'pedidos/1': { id: 1, total: 10 },
  });
  const bucket = bucketFalso();
  const r = await executarBackup({ db, bucket, hoje: '2026-10-08', colecoes: ['clientes', 'pedidos', 'viagens'] });
  assert.equal(r.total, 2);
  assert.deepEqual(r.colecoes, { clientes: 1, pedidos: 1, viagens: 0 });
  const clientes = JSON.parse(bucket.arquivos.get('backups/2026-10-08/clientes.json'));
  assert.equal(clientes[0].nome, 'Ana');
  assert.equal(clientes[0].criado, '2026-01-02T03:04:05.000Z');
  assert.ok(bucket.arquivos.has('backups/2026-10-08/_resumo.json'));
  assert.ok(COLECOES.includes('pedidos') && COLECOES.includes('clientes'));
});

test('limpeza mantém só os dias mais recentes', async () => {
  const bucket = bucketFalso();
  for (const dia of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
    await bucket.file(`backups/${dia}/clientes.json`).save('[]');
  }
  const removidos = await limparBackupsAntigos({ bucket, retencao: 2 });
  assert.deepEqual(removidos, ['2026-10-01', '2026-10-02']);
  assert.deepEqual([...bucket.arquivos.keys()].sort(), ['backups/2026-10-03/clientes.json', 'backups/2026-10-04/clientes.json']);
});

test('agendador usa a proteção de rotinas e o backup noturno', () => {
  const fonte = require('node:fs').readFileSync(require.resolve('../agendamentos'), 'utf8');
  assert.match(fonte, /protegerRotina\(fn\.name/);
  assert.match(fonte, /jobBackupDiario/);
  assert.match(fonte, /'30 3 \* \* \*'/);
});
