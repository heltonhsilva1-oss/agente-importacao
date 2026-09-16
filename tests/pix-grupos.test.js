'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selecionarGrupo, reservarGrupo, confirmarGrupo } = require('../pix-grupos');

const pedido = (id, extras = {}) => ({ id, cliente_id: 1, viagem_id: 9,
  status: 'aguardando_pgto_travessia', total_travessia_brl: 12.35, total_comissao_brl: 50, ...extras });

function banco(dados) {
  const docs = new Map(Object.entries(dados));
  let writes = [];
  const ref = path => ({ path, id: path.split('/').at(-1) });
  const snapshot = path => ({ ref: ref(path), id: path.split('/').at(-1), exists: docs.has(path), data: () => docs.get(path) });
  const db = {
    docs,
    collection: name => ({ doc: id => ref(`${name}/${id}`), where: (_field, _op, id) => ({ limit: () => ({ query: name, id }) }) }),
    runTransaction: async fn => {
      writes = [];
      const result = await fn({
        get: async r => r.query ? { docs: [...docs.entries()].filter(([key, d]) => key.startsWith(`${r.query}/`) && d.id === r.id).map(([key]) => snapshot(key)) } : snapshot(r.path),
        set: (r, d) => writes.push(() => docs.set(r.path, d)),
        update: (r, d) => writes.push(() => docs.set(r.path, { ...docs.get(r.path), ...d })),
      });
      writes.forEach(write => write());
      return result;
    },
  };
  return db;
}

test('agrupa seis pedidos, soma centavos e separa clientes, viagens e etapas', () => {
  const pedidos = Array.from({ length: 6 }, (_, i) => pedido(i + 1));
  assert.equal(selecionarGrupo(pedidos, [1, 2, 3, 4, 5, 6], '1').valor, 74.1);
  assert.throws(() => selecionarGrupo([pedido(1), pedido(2, { cliente_id: 2 })], [1, 2], '1'));
  assert.throws(() => selecionarGrupo([pedido(1), pedido(2, { viagem_id: 8 })], [1, 2], '1'));
  assert.throws(() => selecionarGrupo([pedido(1), pedido(2, { status: 'aguardando_pgto_comissao' })], [1, 2], '1'));
  assert.throws(() => selecionarGrupo(pedidos, [1, 1], '1'));
});

test('comissão final desconta apenas antecipação efetivamente paga', () => {
  const grupo = selecionarGrupo([pedido(1, { status: 'aguardando_pgto_comissao', pagamento_comissao_antecipada: 'pago', valor_comissao_antecipada_brl: 25 }),
    pedido(2, { status: 'aguardando_pgto_comissao' })], [1, 2], '1');
  assert.deepEqual(grupo.itens.map(i => i.valor), [25, 50]);
});

test('reserva repetida reutiliza grupo e chave; grupo sobreposto e Pix antigo são bloqueados', async () => {
  const db = banco({ 'pedidos/1': pedido(1), 'pedidos/2': pedido(2), 'pedidos/3': pedido(3) });
  const args = { db, encontrados: [1, 2].map(id => ({ ref: db.collection('pedidos').doc(id) })), ids: [1, 2], clienteId: '1', email: 'a@b.com' };
  const primeira = await reservarGrupo(args);
  const segunda = await reservarGrupo(args);
  assert.equal(segunda.existing.idempotency_key, primeira.data.idempotency_key);
  await assert.rejects(reservarGrupo({ ...args, encontrados: [2, 3].map(id => ({ ref: db.collection('pedidos').doc(id) })), ids: [2, 3] }), /active_payment_conflict/);
  db.docs.set('cobrancas_pix/3_travessia', { status: 'pendente', provider_order_id: 'antigo' });
  await assert.rejects(reservarGrupo({ ...args, encontrados: [{ ref: db.collection('pedidos').doc(3) }], ids: [3] }), /active_payment_conflict/);
});

for (const percentual of [0, 50]) {
  test(`baixa atômica dos pedidos com antecipação ${percentual} e webhook duplicado`, async () => {
    const charge = { ...selecionarGrupo([pedido(1), pedido(2)], [1, 2], '1'), status: 'pendente', provider_order_id: 'ORD1' };
    const db = banco({ 'pedidos/1': pedido(1), 'pedidos/2': pedido(2), 'viagens/9': { comissao_antecipada_percentual: percentual }, 'cobrancas_pix/grupo': charge });
    const ref = db.collection('cobrancas_pix').doc('grupo');
    assert.equal((await confirmarGrupo(ref, db)).paid, true);
    for (const id of [1, 2]) {
      const atualizado = db.docs.get(`pedidos/${id}`);
      assert.equal(atualizado.pagamento_travessia, 'pago');
      assert.equal(atualizado.status, percentual ? 'aguardando_pgto_comissao_antecipada' : 'em_transito');
      assert.equal(atualizado.pix_travessia.valor, 12.35);
      if (percentual) assert.equal(atualizado.valor_comissao_antecipada_brl, 25);
    }
    assert.equal((await confirmarGrupo(ref, db)).duplicate, true);
  });
}

test('pedido alterado após emissão impede baixa parcial', async () => {
  const charge = { ...selecionarGrupo([pedido(1), pedido(2)], [1, 2], '1'), status: 'pendente', provider_order_id: 'ORD1' };
  const db = banco({ 'pedidos/1': pedido(1), 'pedidos/2': pedido(2, { total_travessia_brl: 99 }), 'viagens/9': {}, 'cobrancas_pix/grupo': charge });
  await assert.rejects(confirmarGrupo(db.collection('cobrancas_pix').doc('grupo'), db), /payment_group_changed/);
  assert.equal(db.docs.get('pedidos/1').pagamento_travessia, undefined);
  assert.equal(db.docs.get('cobrancas_pix/grupo').status, 'pendente');
});
