'use strict';

const express = require('express');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { salvarNotaRecebida } = require('./nota-storage');

const TIPOS_NOTA = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const JANELA_NOTA_MS = 90 * 1000;
const DISTANCIA_FORTE_MS = 60 * 1000;
const VANTAGEM_MINIMA_MS = 20 * 1000;

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
  if (!buffer.length || buffer[0] === 0x3c || !TIPOS_NOTA.has(type)) {
    throw new Error('Arquivo antigo da nota não está mais disponível');
  }
  return { buffer, type };
}

function normalizarTelefone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function timestampMillis(valor) {
  if (typeof valor?.toMillis === 'function') return valor.toMillis();
  if (typeof valor === 'number') return valor < 1e12 ? valor * 1000 : valor;
  if (valor?._seconds != null) return Number(valor._seconds) * 1000;
  if (valor?.seconds != null) return Number(valor.seconds) * 1000;
  return Date.parse(valor) || 0;
}

function mensagemTemMidia(mensagem) {
  const tipo = String(mensagem?.messageType || '').toLowerCase();
  const conteudo = JSON.stringify(mensagem?.content || '').toLowerCase();
  return (
    tipo.includes('image') ||
    tipo.includes('document') ||
    conteudo.includes('imagemessage') ||
    conteudo.includes('documentmessage') ||
    Boolean(mensagem?.fileURL)
  );
}

function selecionarMensagemNota(mensagens, { origem, criadoEm }) {
  const recebidas = (mensagens || []).filter(mensagem => !mensagem?.fromMe && mensagemTemMidia(mensagem));
  const exatas = origem
    ? recebidas.filter(mensagem => JSON.stringify(mensagem).includes(origem))
    : [];
  if (exatas.length === 1) return { mensagem: exatas[0], criterio: 'url_exata' };

  const criadoMs = timestampMillis(criadoEm);
  if (!criadoMs) return null;
  const proximas = recebidas
    .map(mensagem => ({
      mensagem,
      distancia: Math.abs(timestampMillis(mensagem.messageTimestamp) - criadoMs),
    }))
    .filter(item => item.distancia <= JANELA_NOTA_MS)
    .sort((a, b) => a.distancia - b.distancia);

  if (
    proximas.length === 1 ||
    (
      proximas[0]?.distancia <= DISTANCIA_FORTE_MS &&
      proximas[1]?.distancia - proximas[0].distancia >= VANTAGEM_MINIMA_MS
    )
  ) {
    return { mensagem: proximas[0].mensagem, criterio: 'horario_unico' };
  }
  return null;
}

async function chamarUazapi(path, payload) {
  const baseUrl = String(process.env.UAZAPI_SERVER_URL || '').replace(/\/$/, '');
  const token = process.env.UAZAPI_INSTANCE_TOKEN;
  if (!baseUrl || !token) throw new Error('UazAPI não configurada para recuperar nota');

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`UazAPI respondeu HTTP ${response.status}`);
  return response.json();
}

async function buscarMensagensDoCliente(phone) {
  const chatid = `${normalizarTelefone(phone)}@s.whatsapp.net`;
  const mensagens = [];
  let offset = 0;

  for (let pagina = 0; pagina < 5; pagina += 1) {
    const resultado = await chamarUazapi('/message/find', { chatid, limit: 100, offset });
    mensagens.push(...(resultado.messages || []));
    if (!resultado.hasMore) break;
    offset = resultado.nextOffset ?? (offset + 100);
  }
  return mensagens;
}

async function recuperarPeloHistorico(rascunho, origem) {
  const mensagens = await buscarMensagensDoCliente(rascunho.cliente_phone);
  const selecao = selecionarMensagemNota(mensagens, {
    origem,
    criadoEm: rascunho.criado_em,
  });
  if (!selecao) throw new Error('Nenhuma mensagem de mídia pôde ser associada com segurança à nota');

  const id = selecao.mensagem.messageid || selecao.mensagem.id;
  if (!id) throw new Error('Mensagem da nota sem identificador para download');
  const resultado = await chamarUazapi('/message/download', {
    id,
    return_base64: true,
    return_link: false,
  });
  const buffer = Buffer.from(String(resultado.base64Data || ''), 'base64');
  const type = sniffType(buffer, resultado.mimetype);
  if (!buffer.length || !TIPOS_NOTA.has(type)) {
    throw new Error('A mídia recuperada não possui um formato de nota permitido');
  }
  logger.info(`[admin-notas] nota antiga recuperada por ${selecao.criterio}`);
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

      let arquivo;
      try {
        arquivo = await baixarOrigem(origem, !urlEstavel);
      } catch (downloadError) {
        if (urlEstavel) throw downloadError;
        arquivo = await recuperarPeloHistorico(rascunho, origem);
      }
      const { buffer, type } = arquivo;

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
  selecionarMensagemNota,
  setupAdminNotas,
};
