'use strict';
// Firestore falso em memória — o suficiente para testar sem tocar em dados reais.

const path = require('path');

function criarBanco(inicial = {}) {
  const docs = new Map(Object.entries(inicial));
  let auto = 0;

  const snap = caminho => ({
    id: caminho.split('/').at(-1), exists: docs.has(caminho),
    data: () => (docs.has(caminho) ? structuredClone(docs.get(caminho)) : undefined),
    ref: ref(caminho),
  });
  function ref(caminho) {
    return {
      path: caminho, id: caminho.split('/').at(-1),
      get: async () => snap(caminho),
      set: async (d, o) => { docs.set(caminho, o?.merge ? { ...(docs.get(caminho) || {}), ...d } : { ...d }); },
      update: async d => { docs.set(caminho, { ...(docs.get(caminho) || {}), ...d }); },
      delete: async () => { docs.delete(caminho); },
    };
  }
  const listar = (col, filtro) => ({
    docs: [...docs.keys()]
      .filter(k => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
      .map(snap)
      .filter(s => !filtro || filtro(s.data())),
  });
  const colecao = name => ({
    doc: id => ref(`${name}/${id ?? `auto${++auto}`}`),
    add: async d => { const r = ref(`${name}/auto${++auto}`); await r.set(d); return r; },
    get: async () => listar(name),
    where: (campo, _op, valor) => ({ get: async () => listar(name, d => d[campo] === valor) }),
  });
  return {
    docs, collection: colecao,
    runTransaction: async fn => {
      const escritas = [];
      const r = await fn({
        get: async r0 => r0.get(),
        set: (r0, d, o) => escritas.push(() => r0.set(d, o)),
        update: (r0, d) => escritas.push(() => r0.update(d)),
      });
      for (const e of escritas) await e();
      return r;
    },
    batch: () => {
      const ops = [];
      return { set: (r0, d, o) => ops.push(() => r0.set(d, o)), commit: async () => { for (const o of ops) await o(); } };
    },
  };
}

// Carrega um módulo substituindo dependências por stubs (sem rede nem Firestore real).
function carregarComStubs(arquivo, stubs) {
  const salvos = [];
  for (const [alvo, exportado] of Object.entries(stubs)) {
    const resolvido = alvo.startsWith('.') ? require.resolve(path.join(__dirname, '..', '..', alvo)) : require.resolve(alvo);
    salvos.push([resolvido, require.cache[resolvido]]);
    require.cache[resolvido] = { id: resolvido, filename: resolvido, loaded: true, exports: exportado };
  }
  const alvoArquivo = require.resolve(path.join(__dirname, '..', '..', arquivo));
  const anterior = require.cache[alvoArquivo];
  delete require.cache[alvoArquivo];
  const modulo = require(alvoArquivo);
  if (anterior) require.cache[alvoArquivo] = anterior; else delete require.cache[alvoArquivo];
  for (const [resolvido, original] of salvos) {
    if (original) require.cache[resolvido] = original; else delete require.cache[resolvido];
  }
  return modulo;
}

module.exports = { criarBanco, carregarComStubs };
