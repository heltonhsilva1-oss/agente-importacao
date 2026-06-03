'use strict';
// Cron jobs com node-cron

const cron = require('node-cron');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { sendText } = require('./uazapi');
const { getMensagensPendentes, marcarMensagemEnviada } = require('./firestore');

const OPERATOR_PHONE = process.env.OPERATOR_PHONE || '5511995715042';
const AGENT_PHONE    = process.env.AGENT_PHONE    || '5511961482602';
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
  const hist = (pedido.historico_status || []).filter(h => h.status === pedido.status);
  const ultimo = hist[hist.length - 1];
  if (!ultimo?.data) return 999;
  const [d, m, y] = (ultimo.data || '').split('/');
  if (!y) return 999;
  const dt = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
  return (Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24);
}

// Busca pedidos por status com dados do cliente
async function getPedidosComCliente(status) {
  const db = getFirestore();
  const snap = await db.collection('pedidos').where('status', '==', status).get();
  const resultado = [];
  for (const doc of snap.docs) {
    const p = doc.data();
    const cSnap = await db.collection('clientes').where('id', '==', Number(p.cliente_id)).limit(1).get();
    if (cSnap.empty) continue;
    const cliente = cSnap.docs[0].data();
    const phone   = clienteToWhatsapp(cliente);
    if (!phone) continue;
    resultado.push({ pedido: p, cliente, phone });
  }
  return resultado;
}

// ── Lembretes TRAVESSIA — seg a qui às 9h ────────────────────────────────────
async function jobLembreteTravessia() {
  logger.info('[agend] Lembrete travessia');
  const itens = await getPedidosComCliente('aguardando_pgto_travessia');
  for (const { pedido: p, cliente, phone } of itens) {
    if (diasNoStatus(p) < 1) continue;
    const msg =
      `⏰ Olá ${cliente.nome}! Você tem a taxa de travessia pendente: *${fmtCur(p.total_travessia_brl || 0)}*\n\n` +
      `⚠️ *Pague até sexta-feira ao meio-dia* para garantir o embarque.\n` +
      `Avise o pagamento aqui no WhatsApp.`;
    await sendText(phone, msg, true);
    logger.info(`[agend] Lembrete travessia → ${cliente.nome}`);
  }
}

// ── Alerta URGENTE TRAVESSIA — sexta às 9h ───────────────────────────────────
async function jobAlertaUrgenteTravessia() {
  logger.info('[agend] Alerta urgente travessia (sexta)');
  const itens = await getPedidosComCliente('aguardando_pgto_travessia');
  for (const { pedido: p, cliente, phone } of itens) {
    const msg =
      `🚨 *ÚLTIMO DIA, ${cliente.nome}!*\n\n` +
      `A taxa de travessia de *${fmtCur(p.total_travessia_brl || 0)}* precisa ser paga *até hoje ao meio-dia*.\n\n` +
      `Após esse horário sua mercadoria ficará para a próxima viagem.\n` +
      `Avise o pagamento aqui no WhatsApp.`;
    await sendText(phone, msg, true);
    logger.info(`[agend] Alerta urgente travessia → ${cliente.nome}`);
  }
}

// ── Corte TRAVESSIA — sexta ao meio-dia: lista para o operador ───────────────
async function jobCorteTravessia() {
  logger.info('[agend] Corte travessia — sexta meio-dia');
  const itens = await getPedidosComCliente('aguardando_pgto_travessia');
  if (!itens.length) return;
  const lista = itens.map(({ pedido: p, cliente }) =>
    `• Pedido #${p.id} — ${cliente.nome} (${fmtCur(p.total_travessia_brl || 0)})`
  ).join('\n');
  await sendText(OPERATOR_PHONE,
    `🚫 *Sem pagamento de travessia — ficam para a próxima viagem:*\n\n${lista}`, true);
}

// ── Lembretes COMISSÃO — diário às 9h ────────────────────────────────────────
async function jobLembreteComissao() {
  logger.info('[agend] Lembrete comissão');
  const itens = await getPedidosComCliente('aguardando_pgto_comissao');
  for (const { pedido: p, cliente, phone } of itens) {
    if (diasNoStatus(p) < 1) continue;
    const msg =
      `⏰ Olá ${cliente.nome}! Você tem a comissão pendente: *${fmtCur(p.total_comissao_brl || 0)}*\n\n` +
      `⚠️ *Pague até segunda-feira* para garantir o envio da sua mercadoria.\n` +
      `Avise o pagamento aqui no WhatsApp.`;
    await sendText(phone, msg, true);
    logger.info(`[agend] Lembrete comissão → ${cliente.nome}`);
  }
}

// ── Alerta URGENTE COMISSÃO — segunda às 8h ───────────────────────────────────
async function jobAlertaUrgenteComissao() {
  logger.info('[agend] Alerta urgente comissão (segunda)');
  const itens = await getPedidosComCliente('aguardando_pgto_comissao');
  for (const { pedido: p, cliente, phone } of itens) {
    const msg =
      `🚨 *ÚLTIMO DIA, ${cliente.nome}!*\n\n` +
      `A comissão de *${fmtCur(p.total_comissao_brl || 0)}* precisa ser paga *hoje*.\n\n` +
      `Pedidos sem pagamento hoje ficam para a próxima data de envio.\n` +
      `Avise o pagamento aqui no WhatsApp.`;
    await sendText(phone, msg, true);
    logger.info(`[agend] Alerta urgente comissão → ${cliente.nome}`);
  }
}

// ── Corte COMISSÃO — segunda ao meio-dia: lista para o operador ──────────────
async function jobCorteComissao() {
  logger.info('[agend] Corte comissão — segunda meio-dia');
  const itens = await getPedidosComCliente('aguardando_pgto_comissao');
  if (!itens.length) return;
  const lista = itens.map(({ pedido: p, cliente }) =>
    `• Pedido #${p.id} — ${cliente.nome} (${fmtCur(p.total_comissao_brl || 0)})`
  ).join('\n');
  await sendText(OPERATOR_PHONE,
    `🚫 *Sem pagamento de comissão — ficam para a próxima data:*\n\n${lista}`, true);
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
    await sendText(phone,
      `👑 Olá ${c.nome}! Sua mensalidade VIP vence em 3 dias. Entre em contato para renovar.`, true);
    logger.info(`[agend] Aviso VIP → ${c.nome}`);
  }
}

// ── Resumo matinal para o operador — todo dia às 8h ──────────────────────────
async function jobResumoMatinal() {
  logger.info('[agend] Resumo matinal');
  const db = getFirestore();
  const snap = await db.collection('pedidos').get();
  const pedidos = snap.docs.map(d => d.data());
  const conta = (s) => pedidos.filter(p => p.status === s).length;
  const resumo = [
    `📊 *Resumo do dia — ${new Date().toLocaleDateString('pt-BR')}*`,
    '',
    `💰 Ag. pgto. travessia: ${conta('aguardando_pgto_travessia')}`,
    `💰 Ag. pgto. comissão:  ${conta('aguardando_pgto_comissao')}`,
    `🏷️ Ag. etiqueta:        ${conta('aguardando_etiqueta')}`,
    `📦 Ag. envio:           ${conta('aguardando_envio')}`,
    `🚚 Em trânsito:         ${conta('em_transito')}`,
    `📍 Chegou em SP:        ${conta('chegou_sp')}`,
    `🇵🇾 Retirado no PY:     ${conta('retirado_paraguai')}`,
    `✅ Postados:            ${conta('postado')}`,
  ].join('\n');
  await sendText(OPERATOR_PHONE, resumo, true);
}

// ── Alerta pedido parado — todo dia às 9h ────────────────────────────────────
async function jobAlertaPedidoParado() {
  logger.info('[agend] Alerta pedido parado');
  const db = getFirestore();
  const limites = {
    aguardando_pgto_travessia: 5,
    aguardando_pgto_comissao:  5,
    aguardando_etiqueta:       3,
    em_transito:               12,
    chegou_sp:                 3,
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
    await sendText(OPERATOR_PHONE, `⚠️ *Pedidos parados — verificar:*\n\n${alertas.join('\n')}`, true);
    logger.info(`[agend] ${alertas.length} pedido(s) parado(s) alertado(s)`);
  }
}

// ── Enviar mensagens enfileiradas — todo dia às 8h ───────────────────────────
async function jobMensagensAgendadas() {
  logger.info('[agend] Enviando mensagens enfileiradas');
  const { sendMedia } = require('./uazapi');
  const mensagens = await getMensagensPendentes();
  for (const m of mensagens) {
    try {
      if (m.tipo === 'text')  await sendText(m.phone, m.mensagem, true);
      if (m.tipo === 'media') await sendMedia(m.phone, m.mediaUrl, m.mimeType, m.caption || '', true);
      await marcarMensagemEnviada(m.id);
    } catch (err) { logger.error(`[agend] Falha mensagem ${m.id}:`, err.message); }
  }
}

function setupAgendamentos() {
  const r = (fn) => fn().catch(e => logger.error('[agend]', e.message));

  // Toda manhã às 8h — fila + resumo + alerta urgente comissão (segunda)
  cron.schedule('0 8 * * *',   () => r(jobMensagensAgendadas),       { timezone: TZ });
  cron.schedule('0 8 * * *',   () => r(jobResumoMatinal),            { timezone: TZ });
  cron.schedule('0 8 * * 1',   () => r(jobAlertaUrgenteComissao),    { timezone: TZ }); // segunda

  // 9h — lembretes + VIP + pedido parado
  cron.schedule('0 9 * * 1-4', () => r(jobLembreteTravessia),        { timezone: TZ }); // seg-qui
  cron.schedule('0 9 * * *',   () => r(jobLembreteComissao),         { timezone: TZ }); // diário
  cron.schedule('0 9 * * *',   () => r(jobAvisoVip),                 { timezone: TZ });
  cron.schedule('0 9 * * *',   () => r(jobAlertaPedidoParado),       { timezone: TZ });

  // Sexta — alerta urgente de travessia às 9h + corte ao meio-dia
  cron.schedule('0 9  * * 5',  () => r(jobAlertaUrgenteTravessia),   { timezone: TZ });
  cron.schedule('0 12 * * 5',  () => r(jobCorteTravessia),           { timezone: TZ });

  // Segunda — corte de comissão ao meio-dia
  cron.schedule('0 12 * * 1',  () => r(jobCorteComissao),            { timezone: TZ });

  logger.info('[agend] Cron jobs registrados');
}

module.exports = { setupAgendamentos };
