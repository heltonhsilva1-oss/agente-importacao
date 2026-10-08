'use strict';
// Backup diário dos dados essenciais: grava um JSON por coleção no Storage
// (backups/AAAA-MM-DD/<colecao>.json) e mantém só os últimos dias. O caminho
// `backups/` não é lido por nenhuma regra do Storage (acesso só do backend).

const { logger } = require('./logger');

const COLECOES = [
  'clientes', 'pedidos', 'viagens', 'categorias', 'configuracoes', 'rascunhos_pedidos',
  'cobrancas_pix', 'historico_tipo_cliente', 'tabela_free_historico', 'ciclos_mensalidade_vip',
  'eventos_mensalidade_vip', 'avisos_viagem_free', 'migracoes_tipo_cliente',
];
const DIAS_RETIDOS = 14;

// Timestamps do Firestore viram texto ISO no JSON.
function substituto(_chave, valor) {
  if (valor && typeof valor === 'object' && typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (valor && typeof valor === 'object' && valor._seconds != null && valor._nanoseconds != null) {
    return new Date(valor._seconds * 1000).toISOString();
  }
  return valor;
}

function dataSaoPaulo(instante = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instante);
}

// `bucket` e `db` são injetados (Storage e Firestore do Admin SDK).
async function executarBackup({ db, bucket, hoje = dataSaoPaulo(), colecoes = COLECOES }) {
  const resumo = { data: hoje, colecoes: {}, total: 0 };
  for (const nome of colecoes) {
    const snap = await db.collection(nome).get();
    const documentos = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    await bucket.file(`backups/${hoje}/${nome}.json`).save(JSON.stringify(documentos, substituto), {
      resumable: false, contentType: 'application/json',
    });
    resumo.colecoes[nome] = documentos.length;
    resumo.total += documentos.length;
  }
  await bucket.file(`backups/${hoje}/_resumo.json`).save(JSON.stringify({ ...resumo, gerado_em: new Date().toISOString() }), {
    resumable: false, contentType: 'application/json',
  });
  return resumo;
}

// Apaga pastas de dias antigos, mantendo as `retencao` mais recentes.
async function limparBackupsAntigos({ bucket, retencao = DIAS_RETIDOS }) {
  const [arquivos] = await bucket.getFiles({ prefix: 'backups/' });
  const dias = [...new Set(arquivos.map(a => a.name.split('/')[1]).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  const remover = dias.slice(0, Math.max(0, dias.length - retencao));
  for (const dia of remover) {
    await Promise.all(arquivos.filter(a => a.name.startsWith(`backups/${dia}/`)).map(a => a.delete()));
  }
  return remover;
}

async function rodarBackupDiario() {
  const admin = require('firebase-admin');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getBucketName } = require('./nota-storage');
  const bucket = admin.storage().bucket(getBucketName());
  const resumo = await executarBackup({ db: getFirestore(), bucket });
  const removidos = await limparBackupsAntigos({ bucket });
  logger.info(`[backup] ${resumo.data}: ${resumo.total} documentos em ${Object.keys(resumo.colecoes).length} coleções; ${removidos.length} dia(s) antigo(s) removido(s)`);
  return resumo;
}

module.exports = { COLECOES, DIAS_RETIDOS, executarBackup, limparBackupsAntigos, rodarBackupDiario, dataSaoPaulo };
