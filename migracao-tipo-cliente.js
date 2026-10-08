'use strict';
// Migração dos clientes existentes para tipo_cliente = vip | free, usando os
// participantes do grupo "Vip Kidex" na UAZAPI. Somente LEITURA do grupo:
// ninguém é adicionado ou removido. Idempotente e auditável.
//
// Fluxo obrigatório: `previa` devolve contagens e um hash; `aplicar` só roda se
// receber o hash da prévia ainda válido (o grupo/clientes não mudaram).

const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { getGroupParticipants } = require('./uazapi');
const {
  grupoVipJid, GRUPO_VIP_NOME, chaveTelefone, extrairTelefonesParticipantes, classificarClientes, montarConversao,
} = require('./tipo-cliente');
const { getBearerToken } = require('./admin-notas');
const { allowOrigin } = require('./portal');

function hashPrevia(classificacao, telefonesGrupo) {
  const base = JSON.stringify({
    vip: classificacao.vip.map(c => [c.id, c.telefone]).sort(),
    free: classificacao.free.map(c => [c.id, c.telefone]).sort(),
    grupo: [...telefonesGrupo].sort(),
  });
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}

// Monta a prévia. Aborta se o grupo vier vazio (nunca classificar todos como Free
// por falha de leitura).
async function montarPrevia({ db, buscarGrupo = getGroupParticipants, jid = grupoVipJid() }) {
  const grupo = await buscarGrupo(jid);
  const { telefones, semTelefone } = extrairTelefonesParticipantes(grupo.participantes);
  if (telefones.size === 0) {
    throw new Error('Nenhum participante com telefone foi lido do grupo VIP — migração abortada por segurança.');
  }
  const snap = await db.collection('clientes').get();
  const clientes = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
  const c = classificarClientes(clientes, telefones);
  const chavesClientes = new Set(clientes.map(cl => chaveTelefone(cl.telefone)).filter(Boolean));
  const doGrupoSemCliente = [...telefones].filter(t => !chavesClientes.has(t)).length;
  return {
    grupo: { nome: grupo.nome || GRUPO_VIP_NOME, jid, participantes_com_telefone: telefones.size, participantes_sem_telefone: semTelefone },
    totais: {
      clientes: clientes.length,
      seriam_vip: c.vip.length, seriam_free: c.free.length,
      ja_classificados: c.jaClassificados.length, nao_identificados: c.naoIdentificados.length,
      participantes_do_grupo_sem_cadastro: doGrupoSemCliente,
    },
    vip: c.vip, free: c.free, nao_identificados: c.naoIdentificados,
    hash: hashPrevia(c, telefones),
    _classificacao: c, _clientes: clientes,
  };
}

async function aplicarMigracao({ db, hashConfirmado, executadoPor, buscarGrupo, jid, agora = new Date() }) {
  const previa = await montarPrevia({ db, buscarGrupo, jid });
  if (!hashConfirmado || hashConfirmado !== previa.hash) {
    const e = new Error('A prévia mudou ou não foi conferida. Gere a prévia novamente antes de aplicar.');
    e.code = 'previa_desatualizada';
    throw e;
  }
  const porId = new Map(previa._clientes.map(c => [String(c.id), c]));
  const alvos = [...previa._classificacao.vip, ...previa._classificacao.free];
  const migracaoRef = db.collection('migracoes_tipo_cliente').doc();
  let aplicados = 0;
  let batch = db.batch();
  let ops = 0;
  for (const alvo of alvos) {
    const cliente = porId.get(String(alvo.id));
    const docRef = db.collection('clientes').doc(cliente._docId);
    const { campos, evento } = montarConversao(cliente, {
      para: alvo.tipo_novo, motivo: 'migracao_inicial_grupo_vip', origem: `migracao:${migracaoRef.id}`, agora,
    });
    // Quem já está no grupo e tem status_vip de remoção anterior não deve ser
    // sobrescrito: só define status_vip ativo se ainda não houver status.
    if (alvo.tipo_novo === 'vip' && cliente.status_vip && cliente.status_vip !== 'ativo') delete campos.status_vip;
    batch.set(docRef, campos, { merge: true });
    batch.set(db.collection('historico_tipo_cliente').doc(), { ...evento, cliente_doc_id: cliente._docId });
    aplicados += 1; ops += 2;
    if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops) await batch.commit();
  const resumo = { ...previa.totais, aplicados, executado_por: executadoPor || null, hash: previa.hash, criado_em: agora };
  await migracaoRef.set(resumo);
  logger.info(`[migracao-tipo-cliente] aplicada: ${aplicados} clientes (id ${migracaoRef.id})`);
  return { id: migracaoRef.id, ...resumo };
}

function publico(previa) {
  const { _classificacao, _clientes, ...resto } = previa; // eslint-disable-line no-unused-vars
  return resto;
}

async function validarAdmin(req) {
  const token = getBearerToken(req.headers.authorization);
  if (!token) return null;
  const decoded = await admin.auth().verifyIdToken(token);
  const adminDoc = await getFirestore().collection('admins').doc(decoded.uid).get();
  if (!adminDoc.exists || adminDoc.data()?.ativo === false) return null;
  return decoded;
}

function setupMigracaoTipoCliente(app) {
  const router = express.Router();
  const cors = (req, res) => {
    const origin = allowOrigin(req.headers.origin);
    if (origin) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Cache-Control', 'private, no-store');
  };

  router.options('/migracao-tipo-cliente', (req, res) => { cors(req, res); res.status(204).end(); });

  router.post('/migracao-tipo-cliente', async (req, res) => {
    cors(req, res);
    try {
      const decoded = await validarAdmin(req);
      if (!decoded) { res.status(401).json({ error: 'unauthorized' }); return; }
      const db = getFirestore();
      const modo = String(req.body?.modo || 'previa');
      if (modo === 'previa') {
        res.json(publico(await montarPrevia({ db })));
        return;
      }
      if (modo === 'aplicar') {
        const resultado = await aplicarMigracao({
          db, hashConfirmado: req.body?.hash, executadoPor: decoded.email || decoded.uid,
        });
        res.json(resultado);
        return;
      }
      res.status(400).json({ error: 'modo_invalido' });
    } catch (error) {
      logger.error('[migracao-tipo-cliente] erro:', error.message);
      const status = error.code === 'previa_desatualizada' ? 409 : 500;
      res.status(status).json({ error: error.code || 'erro_migracao', mensagem: error.message });
    }
  });

  app.use('/admin-api', router);
}

module.exports = { montarPrevia, aplicarMigracao, hashPrevia, setupMigracaoTipoCliente };
