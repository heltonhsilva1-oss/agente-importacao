'use strict';
// Cron jobs com node-cron — substitui os onSchedule do Firebase Functions

const cron = require('node-cron');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { sendText } = require('./uazapi');
const { getMensagensPendentes, marcarMensagemEnviada } = require('./firestore');

const OPERATOR_PHONE = process.env.OPERATOR_PHONE || '5511995715042';
const AGENT_PHONE    = process.env.AGENT_PHONE    || '5511961482602';
const PORTAL_URL     = process.env.PORTAL_URL     || 'https://minhaimportacao-5442a.web.app/portal';
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

// ── Resumo matinal para o operador — todo dia às 8h ──────────────────────────
async function jobResumoMatinal() {
  logger.info('[agend] Resumo matinal');
  const db = getFirestore();
  const snap = await db.collection('pedidos').get();
  const pedidos = snap.docs.map(d => d.data());

  const conta = (status) => pedidos.filter(p => p.status === status).length;

  const resumo = [
    `📊 *Resumo do dia — ${new Date().toLocaleDateString('pt-BR')}*`,
    '',
    `💰 Ag. pgto. travessia: ${conta('aguardando_pgto_travessia')}`,
    `💰 Ag. pgto. comissão: ${conta('aguardando_pgto_comissao')}`,
    `🏷️ Ag. etiqueta: ${conta('aguardando_etiqueta')}`,
    `📦 Ag. envio: ${conta('aguardando_envio')}`,
    `🚚 Em trânsito: ${conta('em_transito')}`,
    `📍 Chegou em SP: ${conta('chegou_sp')}`,
    `🇵🇾 Retirado no Paraguai: ${conta('retirado_paraguai')}`,
    `✅ Postados: ${conta('postado')}`,
  ].join('\n');

  await sendText(OPERATOR_PHONE, resumo, true);
}

// ── Confirmação de entrega — todo dia às 10h ──────────────────────────────────
async function jobConfirmacaoEntrega() {
  logger.info('[agend] Confirmação de entrega');
  const db = getFirestore();
  const { setConversa } = require('./firestore');

  const snap = await db.collection('pedidos').where('status', '==', 'postado').get();

  for (const doc of snap.docs) {
    const p = doc.data();
    if (p.entrega_confirmada) continue; // já confirmado

    // Descobre quando ficou "postado"
    const hist = (p.historico_status || []).filter(h => h.status === 'postado');
    const ultimo = hist[hist.length - 1];
    if (!ultimo?.data) continue;
    const [d, m, y] = (ultimo.data).split('/');
    if (!y) continue;
    const dataPostado = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
    const dias = (Date.now() - dataPostado.getTime()) / (1000 * 60 * 60 * 24);
    if (dias < 7 || dias > 30) continue; // só entre 7 e 30 dias após postado

    // Busca cliente
    const cSnap = await db.collection('clientes').where('id', '==', Number(p.cliente_id)).limit(1).get();
    if (cSnap.empty) continue;
    const cliente = cSnap.docs[0].data();
    const digits  = (cliente.telefone || '').replace(/\D/g, '');
    if (!digits || digits.length < 10) continue;
    const phone = digits.startsWith('55') ? digits : `55${digits}`;

    const msg =
      `Olá ${cliente.nome}! 😊\n` +
      `Sua encomenda foi postada há ${Math.round(dias)} dias.\n` +
      `Você já recebeu? Responda *SIM* ou *NÃO*.`;

    await sendText(phone, msg, true);
    await setConversa(phone, { estado: 'flow_entrega', dados: { pedido_id: p.id, cliente_nome: cliente.nome } });
    logger.info(`[agend] Confirmação entrega → ${cliente.nome}`);
  }
}

// ── Alerta pedido parado — todo dia às 9h ─────────────────────────────────────
async function jobAlertaPedidoParado() {
  logger.info('[agend] Alerta pedido parado');
  const db = getFirestore();

  // Alerta apenas quando cliente está devendo — transporte é responsabilidade do cliente
  const limites = {
    aguardando_pgto_travessia: 5,
    aguardando_pgto_comissao:  5,
  };

  const snap = await db.collection('pedidos').get();
  const alertas = [];

  for (const doc of snap.docs) {
    const p = doc.data();
    const limite = limites[p.status];
    if (!limite) continue;

    const hist = (p.historico_status || []).filter(h => h.status === p.status);
    const ultimo = hist[hist.length - 1];
    if (!ultimo?.data) continue;
    const [d, m, y] = (ultimo.data).split('/');
    if (!y) continue;
    const dataStatus = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
    const dias = (Date.now() - dataStatus.getTime()) / (1000 * 60 * 60 * 24);

    if (dias >= limite) {
      const cSnap = await db.collection('clientes').where('id', '==', Number(p.cliente_id)).limit(1).get();
      const nome  = cSnap.empty ? `ID ${p.cliente_id}` : cSnap.docs[0].data().nome;
      alertas.push(`• Pedido #${p.id} — ${nome}: ${p.status} há ${Math.round(dias)} dias`);
    }
  }

  if (alertas.length > 0) {
    await sendText(OPERATOR_PHONE,
      `⚠️ *Pedidos parados — verificar:*\n\n${alertas.join('\n')}`, true);
    logger.info(`[agend] ${alertas.length} pedido(s) parado(s) alertado(s)`);
  }
}

function setupAgendamentos() {
  // Todo dia às 8h — fila de mensagens + resumo matinal
  cron.schedule('0 8 * * *', () => jobMensagensAgendadas().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });
  cron.schedule('0 8 * * *', () => jobResumoMatinal().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });

  // Todo dia às 9h — lembretes + aviso VIP + pedido parado
  cron.schedule('0 9 * * *', () => jobLembretes().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });
  cron.schedule('0 9 * * *', () => jobAvisoVip().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });
  cron.schedule('0 9 * * *', () => jobAlertaPedidoParado().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });

  // Toda sexta às 9h — alerta de embarque
  cron.schedule('0 9 * * 5', () => jobAlertaEmbarque().catch((e) => logger.error('[agend]', e.message)), { timezone: TZ });

  // Confirmação de entrega removida — transporte é responsabilidade do cliente

  logger.info('[agend] Cron jobs registrados');
}

module.exports = { setupAgendamentos };
