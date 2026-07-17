'use strict';

const express = require('express');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { salvarNotaRecebida } = require('./nota-storage');

const ORIGINS = new Set([
  'https://minhaimportacao-5442a.web.app',
  'https://minhaimportacao-5442a.firebaseapp.com',
]);

function getBearerToken(header = '') {
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function allowOrigin(origin) {
  if (ORIGINS.has(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || '')) return origin;
  return '';
}

function setCors(req, res) {
  const origin = allowOrigin(req.headers.origin);
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
}

function sniffType(buffer, fallback = '') {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString() === 'RIFF' &&
    buffer.slice(8, 12).toString() === 'WEBP'
  ) return 'image/webp';
  return String(fallback || '').split(';')[0].trim().toLowerCase();
}

async function validarAdmin(req) {
  const token = getBearerToken(req.headers.authorization);
  if (!token) return null;
  const decoded = await admin.auth().verifyIdToken(token);
  const adminDoc = await getFirestore().collection('admins').doc(decoded.uid).get();
  if (!adminDoc.exists || adminDoc.data()?.ativo === false) return null;
  return decoded;
}

async function baixarOrigem(url, usarTokenUazapi) {
  const headers = usarTokenUazapi && process.env.UAZAPI_INSTANCE_TOKEN
    ? { token: process.env.UAZAPI_INSTANCE_TOKEN }
    : {};
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ao recuperar nota`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const type = sniffType(buffer, response.headers.get('content-type'));
  if (!buffer.length || buffer[0] === 0x3c || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(type)) {
    throw new Error('Arquivo antigo da nota não está mais disponível');
  }
  return { buffer, type };
}

function setupAdminNotas(app) {
  const router = express.Router();

  router.options('/notas/:rascunhoId', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });

  router.get('/notas/:rascunhoId', async (req, res) => {
    setCors(req, res);
    try {
      if (!(await validarAdmin(req))) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const db = getFirestore();
      const rascunhoRef = db.collection('rascunhos_pedidos').doc(req.params.rascunhoId);
      const rascunhoDoc = await rascunhoRef.get();
      if (!rascunhoDoc.exists) {
        res.status(404).json({ error: 'nota_not_found' });
        return;
      }

      const rascunho = rascunhoDoc.data();
      const urlEstavel = rascunho.foto_nota?.url;
      const origem = urlEstavel || rascunho.foto_nota_url;
      if (!origem) {
        res.status(404).json({ error: 'nota_not_found' });
        return;
      }

      const { buffer, type } = await baixarOrigem(origem, !urlEstavel);

      if (!urlEstavel) {
        try {
          const foto = await salvarNotaRecebida(buffer, {
            mimeType: type,
            phone: rascunho.cliente_phone,
            loja: rascunho.nome_loja,
          });
          await rascunhoRef.update({ foto_nota: foto, foto_nota_url: foto.url });

          if (rascunho.pedido_id != null) {
            const pedidoRef = db.collection('pedidos').doc(String(rascunho.pedido_id));
            const pedidoDoc = await pedidoRef.get();
            if (pedidoDoc.exists) {
              const pedido = pedidoDoc.data();
              const nota = { ...foto, loja: rascunho.nome_loja || pedido.nome_loja || '' };
              const existentes = pedido.fotos_notas?.length ? pedido.fotos_notas : [];
              if (!existentes.some(item => item.path === nota.path)) {
                await pedidoRef.update({
                  fotos_notas: [...existentes, nota],
                  foto_nota_fiscal: pedido.foto_nota_fiscal || nota,
                });
              }
            }
          }
        } catch (archiveError) {
          logger.error('[admin-notas] falha ao tornar nota permanente:', archiveError.message);
        }
      }

      res.type(type).send(buffer);
    } catch (error) {
      logger.error('[admin-notas] erro:', error.message);
      if (!res.headersSent) res.status(410).json({ error: 'nota_unavailable' });
    }
  });

  app.use('/admin-api', router);
}

module.exports = {
  getBearerToken,
  sniffType,
  setupAdminNotas,
};
