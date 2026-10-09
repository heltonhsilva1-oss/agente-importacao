'use strict';

const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { TABELA_FREE_PADRAO, validarTabelaFree } = require('./tabela-free');

const tabelas = new Map([[TABELA_FREE_PADRAO.versao, TABELA_FREE_PADRAO]]);

function registrarTabelaFree(tabela) {
  if (!tabela?.versao || validarTabelaFree(tabela).length) return false;
  tabelas.set(String(tabela.versao), tabela);
  return true;
}

function getTabelaFreePorVersao(versao) {
  return tabelas.get(String(versao || '')) || null;
}

function setupTabelasFreeStore() {
  const db = getFirestore();
  db.collection('tabela_free_historico').onSnapshot(snap => {
    for (const change of snap.docChanges()) {
      if (change.type !== 'removed') registrarTabelaFree(change.doc.data());
    }
    logger.info(`[tabela-free] ${tabelas.size} versão(ões) disponíveis para validação`);
  }, error => logger.error('[tabela-free] Falha ao carregar histórico:', error.message));

}

module.exports = { setupTabelasFreeStore, registrarTabelaFree, getTabelaFreePorVersao };
