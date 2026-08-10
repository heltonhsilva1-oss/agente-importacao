'use strict';

const express = require('express');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const {
  onlyDigits,
  normalizePhone,
  verifyPortalPhone,
  issuePortalSession,
} = require('./portal-access');

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 20;

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip, now = Date.now()) {
  const current = attempts.get(ip);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    attempts.set(ip, { count: 1, startedAt: now });
    return false;
  }

  current.count += 1;
  return current.count > MAX_ATTEMPTS;
}

function allowOrigin(origin) {
  if (!origin) return '';
  const configured = String(process.env.PORTAL_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const defaults = [
    'https://minhaimportacao-5442a.web.app',
    'https://minhaimportacao-5442a.firebaseapp.com',
  ];
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
  return [...configured, ...defaults].includes(origin) ? origin : '';
}

function setCors(req, res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  const origin = allowOrigin(req.headers.origin);
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sanitizeCliente(cliente) {
  return {
    id: cliente.id,
    nome: cliente.nome || cliente.name || 'Cliente',
  };
}

function sanitizePedido(pedido) {
  const allowed = [
    'id', 'cliente_id', 'viagem_id', 'nome_loja', 'cotacao_dolar', 'produtos',
    'status', 'historico_status', 'pagamento_travessia', 'pagamento_comissao',
    'status_pagamento', 'total_travessia_brl', 'total_comissao_brl',
    'transportadora', 'codigo_rastreio', 'data_envio', 'foto_nota_fiscal',
    'fotos_notas', 'dados_caixa',
  ];
  return Object.fromEntries(
    allowed.filter((key) => pedido[key] !== undefined).map((key) => [key, pedido[key]])
  );
}

function sanitizeSeparacaoCliente(separacao) {
  const foto = separacao?.foto_final;
  const url = typeof foto?.url === 'string' && foto.url.startsWith('https://')
    ? foto.url
    : '';
  if (!url) return null;
  return {
    id: String(separacao.separacao_id || ''),
    viagem_id: String(separacao.viagem_id || ''),
    pedido_ids: Array.isArray(separacao.pedido_ids) ? separacao.pedido_ids.map(String) : [],
    lojas: Array.isArray(separacao.lojas) ? separacao.lojas.map(String) : [],
    total_esperado: Math.max(0, Number(separacao.total_esperado) || 0),
    foto: {
      url,
      name: String(foto.name || 'separacao.jpg'),
      type: String(foto.type || 'image/jpeg'),
    },
  };
}

async function findClienteByCredentials(cpf, ultimosDigitos) {
  const cpfLimpo = onlyDigits(cpf);
  const digitos = onlyDigits(ultimosDigitos);
  if (cpfLimpo.length !== 11 || digitos.length !== 4) return null;

  const snap = await getFirestore().collection('clientes').get();
  for (const doc of snap.docs) {
    const cliente = doc.data();
    if (cliente.ativo === false) continue;
    if (
      onlyDigits(cliente.cpf) === cpfLimpo &&
      onlyDigits(cliente.telefone).slice(-4) === digitos
    ) return cliente;
  }
  return null;
}

async function findClienteBySignedPhone(phone, signature) {
  if (!verifyPortalPhone(phone, signature)) return null;
  const normalized = normalizePhone(phone);
  const snap = await getFirestore().collection('clientes').get();
  for (const doc of snap.docs) {
    const cliente = doc.data();
    if (cliente.ativo === false) continue;
    if (normalizePhone(cliente.telefone) === normalized) return cliente;
  }
  return null;
}

async function loadPortalData(cliente) {
  const db = getFirestore();
  const [pedidosSnap, categoriasSnap, separacoesSnap] = await Promise.all([
    db.collection('pedidos').get(),
    db.collection('categorias').get(),
    db.collection('separacoes_clientes').get(),
  ]);

  const pedidos = pedidosSnap.docs
    .map((doc) => doc.data())
    .filter((pedido) => String(pedido.cliente_id) === String(cliente.id))
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map(sanitizePedido);

  const pedidoIdsCliente = new Set(pedidos.map((pedido) => String(pedido.id)));
  const separacoes = separacoesSnap.docs
    .map((doc) => doc.data())
    .filter((separacao) => (
      String(separacao.cliente_id) === String(cliente.id)
      && separacao.status === 'concluida'
      && Array.isArray(separacao.pedido_ids)
      && separacao.pedido_ids.length > 0
      && separacao.pedido_ids.every((pedidoId) => pedidoIdsCliente.has(String(pedidoId)))
    ))
    .map(sanitizeSeparacaoCliente)
    .filter(Boolean)
    .sort((a, b) => Number(b.viagem_id) - Number(a.viagem_id));

  return {
    cliente: sanitizeCliente(cliente),
    pedidos,
    categorias: categoriasSnap.docs.map((doc) => doc.data()),
    separacoes,
  };
}

function setupPortal(app) {
  const router = express.Router();

  router.options('/acesso', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });

  router.post('/acesso', async (req, res) => {
    setCors(req, res);
    const requestOrigin = req.headers.origin;
    if (requestOrigin && !allowOrigin(requestOrigin)) {
      res.status(403).json({ ok: false, error: 'origin_not_allowed' });
      return;
    }

    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      res.status(429).json({ ok: false, error: 'too_many_attempts' });
      return;
    }

    try {
      const { cpf, ultimosDigitos, tel, acesso } = req.body || {};
      const cliente = tel
        ? await findClienteBySignedPhone(tel, acesso)
        : await findClienteByCredentials(cpf, ultimosDigitos);

      if (!cliente) {
        res.status(401).json({ ok: false, error: 'invalid_credentials' });
        return;
      }

      const sessionToken = issuePortalSession(cliente.id);
      if (!sessionToken) {
        logger.error('[portal] PORTAL_LINK_SECRET ausente ou inválido para criar sessão');
        res.status(503).json({ ok: false, error: 'portal_not_configured' });
        return;
      }

      res.json({ ok: true, sessionToken, ...(await loadPortalData(cliente)) });
    } catch (err) {
      logger.error('[portal] Erro ao carregar dados:', err.message);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  app.use('/portal-api', router);
}

module.exports = {
  setupPortal,
  allowOrigin,
  isRateLimited,
  sanitizeCliente,
  sanitizePedido,
  sanitizeSeparacaoCliente,
  setCors,
};
