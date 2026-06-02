'use strict';
// Cron jobs com node-cron — substitui os onSchedule do Firebase Functions

const cron = require('node-cron');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { sendText } = require('./uazapi');
const { getMensagensPendentes, marcarMensagemEnviada } = require('./firestore');

const AGENT_PHONE = process.env.AGENT_PHONE || '5511961482602';
const TZ = 'America/Sao_Paulo';

function fmtCur(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function clienteToWhatsapp(c) {
  if (!c?.telefone) return null;
  const d = c.telefone.replace(/\D/g, '');
  return d.length >= 10 ? (d.startsWith('55') ? d : `55${d}`) : null;
}

function diasNoStatus(pedido) {
  const hist = (pedido.historico_status || []).filter((h) => h.status === pedido.status);
  const ultimo = hist[hist.length - 1];
  if (!ultimo?.data) return 999;
  const [d, m, y] = (ultimo.data || '').split('/');
  if (!y) return 999;
  const dt = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  return (Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24);
}

// ── Lembrete de pagamento pendente — todo dia às 9h ───────────────────────────
async function jobLembretes() {
  logger.info('[agend] Rodando lembretes de pagamento');
  const db = getFirestore();

  const snap = await db
    .collection('pedidos')
    .where('status', 'in', ['aguardando_pgto_travessia', 'aguardando_pgto_comissao'])
    .get();

  for (const doc of snap.docs) {
    const p = doc.data();
    if (diasNoStatus(p) < 2) continue;

    const cSnap = await db.collection('clientes').where('id', '==', Number(p.cliente_id)).limit(1).get();
    if (cSnap.empty) continue;

    const cliente = cSnap.docs[0].data();
    const phone = clienteToWhatsapp(cliente);
    if (!phone) continue;

    const trav = p.total_travessia_brl || 0;
    const com  = p.total_comissao_brl  || 0;
    const partes = [];
    if (trav > 0) partes.push(`Taxa de travessia: ${fmtCur(trav)}`);
    if (com  > 0) partes.push(`Comissão: ${fmtCur(com)}`);

    const msg =
      `⏰ Olá ${cliente.nome}! Você ainda tem pagamento pendente.\n` +
      `${partes.join(' / ')}\n` +
      `Acesse o WhatsApp do agente para regularizar: https://wa.me/${AGENT_PHONE}`;

    await sendText(phone, msg, true);
    logger.info(`[agend] Lembrete → ${cliente.nome}`);
  }
}

// ── Alerta de embarque — toda sexta às 9h ─────────────────────────────────────
async function jobAlertaEmbarque() {
  logger.info('[agend] Alerta de embarque (sexta-feira)');
  const db = getFirestore();

  const snap = await db.collection('pedidos').where('status', '==', 'aguardando_pgto_travessia').get();

  for (const doc of snap.docs) {
    const p = doc.data();
    const cSnap = await db.collection('clientes').where('id', '==', Number(p.cliente_id)).limit(1).get();
    if (cSnap.empty) continue;

    const cliente = cSnap.docs[0].data();
    const phone = clienteToWhatsapp(cliente);
    if (!phone) continue;

    const msg =
      `🚨 ${cliente.nome}, sua mercadoria embarca em breve e a taxa de travessia ainda não foi paga.\n` +
      `Pague hoje para garantir o embarque!\n\n` +
      `Acesse: https://wa.me/${AGENT_PHONE}`;

    await sendText(phone, msg, true);
    logger.info(`[agend] Alerta embarque → ${cliente.nome}`);
  }
}

// ── Aviso de VIP vencendo — todo dia às 9h ────────────────────────────────────
async function jobAvisoVip() {
  logger.info('[agend] Aviso de VIP vencendo');
  const db = getFirestore();

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const snap = await db.collection('clientes').get();

  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.status_mensalidade === 'paga') continue;

    const diaVenc = parseInt(c.data_vencimento_mensalidade);
    if (isNaN(diaVenc)) continue;

    const venc = new Date(hoje.getFullYear(), hoje.getMonth(), diaVenc);
    if (venc < hoje) venc.setMonth(venc.getMonth() + 1);

    const diffDias = Math.round((venc.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDias !== 3) continue;

    const phone = clienteToWhatsapp(c);
    if (!phone) continue;

    const msg =
      `👑 Olá ${c.nome}! Sua mensalidade VIP vence em 3 dias.\n` +
      `Entre em contato para renovar e continuar com os benefícios exclusivos.\n\n` +
      `Acesse: https://wa.me/${AGENT_PHONE}`;

    await sendText(phone, msg, true);
    logger.info(`[agend] Aviso VIP → ${c.nome}`);
  }
}

// ── Enviar mensagens enfileiradas — todo dia às 8h ────────────────────────────
async function jobMensagensAgendadas() {
  logger.info('[agend] Enviando mensagens enfileiradas');
  const { sendMedia } = require('./uazapi');

  const mensagens = await getMensagensPendentes();
  logger.info(`[agend] ${mensagens.length} mensagem(ns) na fila`);

  for (const m of mensagens) {
    try {
      if (m.tipo === 'text') {
        await sendText(m.phone, m.mensagem, true);
      } else if (m.tipo === 'media') {
        await sendMedia(m.phone, m.mediaUrl, m.mimeType, m.caption || '', true);
      }
      await marcarMensagemEnviada(m.id);
      logger.info(`[agend] Mensagem ${m.id} enviada → ${m.phone}`);
    } catch (err) {
      logger.error(`[agend] Falha mensagem ${m.id}:`, err.message);
    }
  }
}

function setupAgendamentos() {
  // Todo dia às 9h — lembretes de pagamento
  cron.schedule('0 9 * * *', () => jobLembretes().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });

  // Toda sexta às 9h — alerta de embarque
  cron.schedule('0 9 * * 5', () => jobAlertaEmbarque().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });

  // Todo dia às 9h — aviso VIP
  cron.schedule('0 9 * * *', () => jobAvisoVip().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });

  // Todo dia às 8h — fila de mensagens
  cron.schedule('0 8 * * *', () => jobMensagensAgendadas().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });

  logger.info('[agend] Cron jobs registrados');
}

module.exports = { setupAgendamentos };
