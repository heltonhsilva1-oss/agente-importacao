'use strict';

const LOJAS_PADRAO = [
  { id: 'atn', nomeOficial: 'ATN', aliases: ['Atn', 'atn'] },
  { id: 'star-company', nomeOficial: 'Star Company', aliases: ['Star', 'star', 'StarCompany'] },
  { id: 'primeshop', nomeOficial: 'PRIMESHOP', aliases: ['Prime', 'Prime Shop', 'PrimeShop'] },
];

function chaveLoja(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function limparRegrasLojas(regras) {
  return (Array.isArray(regras) ? regras : LOJAS_PADRAO)
    .map((regra, indice) => ({
      id: String(regra.id || `loja-${indice + 1}`),
      nomeOficial: String(regra.nomeOficial || '').replace(/\s+/g, ' ').trim(),
      aliases: [...new Set((Array.isArray(regra.aliases) ? regra.aliases : [])
        .map(alias => String(alias || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean))],
    }))
    .filter(regra => regra.nomeOficial);
}

function padronizarNomeLoja(value, regras) {
  const nome = String(value || '').replace(/\s+/g, ' ').trim();
  if (!nome) return '';
  const chave = chaveLoja(nome);
  const lista = limparRegrasLojas(regras);
  for (let indice = lista.length - 1; indice >= 0; indice -= 1) {
    const regra = lista[indice];
    const nomes = [regra.nomeOficial, ...regra.aliases];
    if (nomes.some(item => chaveLoja(item) === chave)) return regra.nomeOficial;
  }
  return nome;
}

module.exports = { LOJAS_PADRAO, chaveLoja, limparRegrasLojas, padronizarNomeLoja };
