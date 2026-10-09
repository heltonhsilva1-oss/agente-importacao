'use strict';
// Migração dos clientes existentes para tipo_cliente = vip | free, usando os
// participantes do grupo "Vip Kidex" na UAZAPI. A migração usa somente leitura;
// alterações manuais posteriores sincronizam o grupo. Operações idempotentes e auditáveis.
//
// Fluxo obrigatório: `previa` devolve contagens e um hash; `aplicar` só roda se
// receber o hash da prévia ainda válido (o grupo/clientes não mudaram).

const crypto = require('crypto');
const express = require('express');
const { randomUUID } = require('node:crypto');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { getGroupParticipants } = require('./uazapi');
const { updateGroupParticipants } = require('./uazapi');
const {
  grupoVipJid, GRUPO_VIP_NOME, chaveTelefone, extrairTelefonesParticipantes, classificarClientes, montarConversao, getTipoCliente,
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
    // A presença atual no grupo é a verdade do estado atual. Remoções antigas
    // permanecem no histórico, mas não podem deixar um membro como removido.
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

async function buscarCliente(db, clienteId) {
  const numeric = Number(clienteId);
  const snap = Number.isFinite(numeric)
    ? await db.collection('clientes').where('id', '==', numeric).get()
    : { empty: true };
  if (!snap.empty) return snap.docs[0];
  const direto = await db.collection('clientes').doc(String(clienteId || '')).get();
  return direto.exists ? direto : null;
}

async function alterarTipoCliente({ db, clienteId, para, motivo = 'alteracao_manual', operacaoId, executadoPor,
  atualizarGrupo = updateGroupParticipants, agora = new Date() }) {
  if (!['vip', 'free'].includes(para)) throw Object.assign(new Error('Tipo de cliente inválido.'), { code: 'tipo_invalido' });
  const opId = String(operacaoId || randomUUID()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
  if (!opId) throw Object.assign(new Error('Operação inválida.'), { code: 'operacao_invalida' });
  const opRef = db.collection('alteracoes_tipo_cliente').doc(opId);
  const anteriorOp = await opRef.get();
  if (anteriorOp.exists && anteriorOp.data().status === 'concluida') return { id: opId, ...anteriorOp.data(), repetida: true };

  const clienteDoc = await buscarCliente(db, clienteId);
  if (!clienteDoc) throw Object.assign(new Error('Cliente não encontrado.'), { code: 'cliente_nao_encontrado' });
  const cliente = clienteDoc.data();
  const telefone = chaveTelefone(cliente.telefone);
  if (!telefone) throw Object.assign(new Error('Cliente sem WhatsApp válido.'), { code: 'telefone_invalido' });
  const de = getTipoCliente(cliente);
  await opRef.set({
    cliente_doc_id: clienteDoc.id, cliente_id: cliente.id ?? clienteDoc.id, cliente_nome: cliente.nome || '',
    telefone, de, para, motivo, status: 'sincronizando_grupo', executado_por: executadoPor || null,
    solicitado_em: anteriorOp.data()?.solicitado_em || agora, atualizado_em: agora,
  }, { merge: true });

  try {
    await atualizarGrupo(grupoVipJid(), para === 'vip' ? 'add' : 'remove', [telefone]);
    const campos = {
      tipo_cliente: para,
      status_vip: para === 'vip' ? 'ativo' : motivo === 'remocao_inadimplencia' ? 'removido_inadimplencia' : 'removido_manual',
      tipo_cliente_atualizado_em: agora,
      ultima_sincronizacao_grupo_vip_em: agora,
    };
    if (para === 'vip') campos.reincluido_grupo_vip_em = agora;
    else campos.removido_grupo_vip_em = agora;
    const batch = db.batch();
    batch.set(clienteDoc.ref, campos, { merge: true });
    batch.set(db.collection('historico_tipo_cliente').doc(), {
      cliente_doc_id: clienteDoc.id, cliente_id: cliente.id ?? clienteDoc.id, cliente_nome: cliente.nome || '',
      de, para, motivo, origem: 'painel_clientes', operacao_id: opId,
      alterado_por: executadoPor || null, criado_em: agora,
    });
    batch.set(opRef, { status: 'concluida', concluida_em: agora, atualizado_em: agora }, { merge: true });
    await batch.commit();
    return { id: opId, status: 'concluida', de, para, cliente_id: cliente.id ?? clienteDoc.id };
  } catch (error) {
    await opRef.set({ status: 'falha', ultimo_erro: String(error.response?.data?.message || error.message).slice(0, 500),
      atualizado_em: new Date() }, { merge: true }).catch(() => {});
    throw Object.assign(new Error(`Não foi possível sincronizar o Grupo VIP: ${error.message}`), { code: 'falha_sincronizacao_grupo' });
  }
}

async function diagnosticarTiposCliente({ db, buscarGrupo = getGroupParticipants, jid = grupoVipJid() }) {
  const grupo = await buscarGrupo(jid);
  const { telefones, semTelefone } = extrairTelefonesParticipantes(grupo.participantes);
  if (!telefones.size) throw new Error('O grupo VIP não retornou participantes com telefone.');
  const snap = await db.collection('clientes').get();
  const clientes = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
  const divergencias = [];
  const cadastrados = new Set();
  for (const c of clientes) {
    const telefone = chaveTelefone(c.telefone);
    if (!telefone) {
      if (getTipoCliente(c) === 'vip') divergencias.push({ tipo: 'vip_sem_telefone', cliente_id: c.id, nome: c.nome || '' });
      continue;
    }
    cadastrados.add(telefone);
    const noGrupo = telefones.has(telefone);
    const tipo = getTipoCliente(c);
    if (noGrupo && (tipo !== 'vip' || c.status_vip !== 'ativo')) divergencias.push({ tipo: 'no_grupo_nao_ativo', cliente_id: c.id, nome: c.nome || '', telefone, cadastro: tipo, status_vip: c.status_vip || null });
    if (!noGrupo && tipo === 'vip') divergencias.push({ tipo: 'vip_fora_do_grupo', cliente_id: c.id, nome: c.nome || '', telefone });
  }
  for (const telefone of telefones) if (!cadastrados.has(telefone)) divergencias.push({ tipo: 'participante_sem_cadastro', telefone });
  return { grupo: grupo.nome || GRUPO_VIP_NOME, participantes_sem_telefone: semTelefone, total: divergencias.length, divergencias };
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

  router.options('/tipo-cliente', (req, res) => { cors(req, res); res.status(204).end(); });
  router.post('/tipo-cliente', async (req, res) => {
    cors(req, res);
    try {
      const decoded = await validarAdmin(req);
      if (!decoded) { res.status(401).json({ error: 'unauthorized' }); return; }
      const resultado = await alterarTipoCliente({
        db: getFirestore(), clienteId: req.body?.clienteId, para: String(req.body?.para || '').toLowerCase(),
        motivo: req.body?.motivo || 'alteracao_manual', operacaoId: req.body?.operacaoId,
        executadoPor: decoded.email || decoded.uid,
      });
      res.json(resultado);
    } catch (error) {
      logger.error('[tipo-cliente] erro:', error.message);
      res.status(error.code === 'cliente_nao_encontrado' ? 404 : 409).json({ error: error.code || 'erro_tipo_cliente', mensagem: error.message });
    }
  });

  router.options('/diagnostico-tipo-cliente', (req, res) => { cors(req, res); res.status(204).end(); });
  router.post('/diagnostico-tipo-cliente', async (req, res) => {
    cors(req, res);
    try {
      const decoded = await validarAdmin(req);
      if (!decoded) { res.status(401).json({ error: 'unauthorized' }); return; }
      res.json(await diagnosticarTiposCliente({ db: getFirestore() }));
    } catch (error) {
      res.status(502).json({ error: 'erro_diagnostico', mensagem: error.message });
    }
  });

  app.use('/admin-api', router);
}

module.exports = { montarPrevia, aplicarMigracao, alterarTipoCliente, diagnosticarTiposCliente, hashPrevia, setupMigracaoTipoCliente };
