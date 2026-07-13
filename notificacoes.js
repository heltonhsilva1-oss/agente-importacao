'use strict';
// Listeners Firestore em tempo real — substitui os gatilhos do Firebase Functions
// Roda dentro do servidor Express, escutando mudanças via onSnapshot

const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { sendText } = require('./uazapi');
const { setConversa, clearConversa } = require('./firestore');
const { getCobrancaPendente } = require('./pagamentos');
const { buildPortalLink } = require('./portal-access');

const AGENT_PHONE  = process.env.AGENT_PHONE  || '5511961482602';
const PORTAL_URL   = process.env.PORTAL_URL   || 'https://minhaimportacao-5442a.web.app/portal';

function fmtCur(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function clienteToWhatsapp(cliente) {
  if (!cliente?.telefone) return null;
  const d = cliente.telefone.replace(/\D/g, '');
  return d.length >= 10 ? (d.startsWith('55') ? d : `55${d}`) : null;
}

async function getClienteById(clienteId) {
  const snap = await getFirestore()
    .collection('clientes')
    .where('id', '==', Number(clienteId))
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].data();
}

function buildMensagemStatus(status, nome, trav, com, phone) {
  const portal = phone ? buildPortalLink(PORTAL_URL, phone) : PORTAL_URL;

  const msgs = {
    retirado_paraguai:
      `Olá ${nome}! Sua mercadoria foi retirada no Paraguai.\n\n` +
      `Acompanhe no portal: ${portal}`,
    aguardando_pgto_travessia:
      `Olá ${nome}! Sua mercadoria está pronta para embarcar.\n` +
      `O valor da taxa de travessia é *${fmtCur(trav)}*.\n\n` +
      `Após pagar, é só enviar o comprovante aqui nessa conversa.\nVer detalhes: ${portal}`,
    em_transito:
      `Olá ${nome}! Sua mercadoria está a caminho de São Paulo.\n\n` +
      `Acompanhe no portal: ${portal}`,
    chegou_sp:
      `Olá ${nome}! Sua mercadoria chegou em São Paulo.\n\n` +
      `*Para garantir o envio hoje*, você precisa concluir ainda hoje:\n` +
      `1. Pagar a comissão de *${fmtCur(com)}* (avise aqui no WhatsApp)\n` +
      `2. Enviar a etiqueta de postagem\n\n` +
      `Pedidos que não concluírem todos os passos hoje ficam para a próxima data de envio.\n\n` +
      `Ver detalhes no portal: ${portal}`,
    aguardando_pgto_comissao:
      `Olá ${nome}! Sua mercadoria chegou em SP.\n` +
      `O valor da comissão é *${fmtCur(com)}*.\n\n` +
      `Pague hoje para garantir o envio.\nApós pagar, é só enviar o comprovante aqui nessa conversa.\nVer detalhes: ${portal}`,
    aguardando_etiqueta:
      `Olá ${nome}! Pagamento confirmado.\n\n` +
      `Veja as medidas e endereço da caixa no portal: ${portal}\n\n` +
      `Depois é só enviar a etiqueta aqui nessa conversa.`,
    aguardando_envio:
      `Olá ${nome}! Sua etiqueta foi confirmada. Em breve sua encomenda será postada.\n\n` +
      `Acompanhe no portal: ${portal}`,
    postado:
      `Olá ${nome}! Sua encomenda foi postada.\n` +
      `Acompanhe pelo código da etiqueta que você gerou.\n\n` +
      `Ver no portal: ${portal}`,
  };
  return msgs[status] || null;
}

async function notificarTodosClientes(mensagem) {
  const snap = await getFirestore().collection('clientes').get();
  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.ativo === false) continue;
    const d = (c.telefone || '').replace(/\D/g, '');
    if (!d || d.length < 10) continue;
    const phone = d.startsWith('55') ? d : `55${d}`;
    try {
      await sendText(phone, mensagem, true);
      await new Promise(r => setTimeout(r, 600)); // delay anti-spam
    } catch (_) {}
  }
}

// Agrupa notificações do mesmo cliente + status numa janela de tempo,
// para não disparar uma mensagem por pedido quando há vários de uma vez.
const NOTIF_DEBOUNCE_MS = 6000;
const notifPend = new Map(); // key `${clienteId}:${status}` -> { pedidos: [], timer }

function agendarNotif(clienteId, status, pedido, handler) {
  const key = `${clienteId}:${status}`;
  let entry = notifPend.get(key);
  if (!entry) { entry = { pedidos: [], timer: null }; notifPend.set(key, entry); }
  if (!entry.pedidos.some(p => String(p.id) === String(pedido.id))) entry.pedidos.push(pedido);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    notifPend.delete(key);
    Promise.resolve(handler(entry.pedidos))
      .catch(err => logger.error('[notif] erro no envio agrupado:', err.message));
  }, NOTIF_DEBOUNCE_MS);
}

function setupListeners() {
  const db = getFirestore();

  // Resolve cliente + telefone válido a partir do id
  async function resolveDestino(clienteId) {
    const cliente = await getClienteById(clienteId);
    if (!cliente) { logger.warn(`[notif] Cliente ${clienteId} não encontrado`); return null; }
    const phone = clienteToWhatsapp(cliente);
    if (!phone) { logger.warn(`[notif] Cliente ${cliente.nome} sem telefone válido`); return null; }
    return { cliente, phone };
  }

  // Envia UMA mensagem de "nota recebida" cobrindo todos os pedidos do grupo
  async function enviarNotaRecebida(pedidos) {
    const destino = await resolveDestino(pedidos[0].cliente_id);
    if (!destino) return;
    const { cliente, phone } = destino;
    const portal = buildPortalLink(PORTAL_URL, phone);
    const n = pedidos.length;
    const msg = n > 1
      ? `Olá ${cliente.nome}! Recebemos suas ${n} notas fiscais.\n\n` +
        `Em breve vamos retirar seus pedidos no Paraguai.\n\nAcompanhe pelo portal: ${portal}`
      : `Olá ${cliente.nome}! Recebemos sua nota fiscal.\n\n` +
        `Em breve vamos retirar seu pedido no Paraguai.\n\nAcompanhe pelo portal: ${portal}`;
    await sendText(phone, msg, true);
    logger.info(`[notif] ✅ Nota recebida (${n} pedido[s]) → ${cliente.nome} (${phone})`);
  }

  // Envia UMA mensagem de mudança de status somando os valores de todos os pedidos
  async function enviarStatus(status, pedidos) {
    const destino = await resolveDestino(pedidos[0].cliente_id);
    if (!destino) return;
    const { cliente, phone } = destino;

    const trav = pedidos.reduce((s, p) => s + (p.total_travessia_brl || 0), 0);
    const com  = pedidos.reduce((s, p) => s + (p.total_comissao_brl  || 0), 0);

    let msg = buildMensagemStatus(status, cliente.nome, trav, com, phone);
    if (!msg) { logger.info(`[notif] Status ${status} sem mensagem — ignorado`); return; }
    if (pedidos.length > 1) msg += `\n\n(Referente a ${pedidos.length} pedidos)`;

    await sendText(phone, msg, true);
    logger.info(`[notif] ✅ Notificado ${cliente.nome} (${phone}): ${status} — ${pedidos.length} pedido(s)`);

    // Estados de resposta rápida (comprovante / etiqueta)
    if (status === 'aguardando_pgto_travessia' || status === 'aguardando_pgto_comissao') {
      const itens = pedidos
        .map(p => { const c = getCobrancaPendente(p); return c ? { id: p.id, tipo: c.tipo, valor: c.valor } : null; })
        .filter(Boolean);
      if (itens.length) {
        await setConversa(phone, {
          estado: 'flow4_comprovante',
          dados: {
            cliente_nome:          cliente.nome,
            pedidos_pagamento:     itens,                       // multi-pedido
            pedido_selecionado_id: itens[0].id,                 // compat single
            pagamento_tipo:        itens[0].tipo,
            pagamento_valor:       itens.reduce((s, i) => s + i.valor, 0),
          },
        });
        logger.info(`[notif] ${cliente.nome} no fluxo de comprovante (${itens.length} pedido[s])`);
      }
    }

    if (status === 'aguardando_etiqueta') {
      await setConversa(phone, { estado: 'flow4_etiqueta', dados: { cliente_nome: cliente.nome } });
      logger.info(`[notif] ${cliente.nome} no fluxo de etiqueta`);
    }
  }

  // ── Listener de pedidos — detecta mudança de status ───────────────────────
  // Cache em memória para saber o status anterior de cada pedido
  const statusCache = new Map();
  let pedidosCarregados = false;

  db.collection('pedidos').onSnapshot(
    (snap) => {
      snap.docChanges().forEach((change) => {
        const pedido = change.doc.data();
        const id = String(pedido.id);

        if (change.type === 'removed') {
          statusCache.delete(id);
          return;
        }

        if (change.type === 'added') {
          const primeiraCarga = !pedidosCarregados;
          statusCache.set(id, pedido.status);
          if (primeiraCarga) return;
          // Novo pedido após carga inicial → agrupa notificação de nota recebida
          logger.info(`[notif] Novo pedido #${pedido.id} status=${pedido.status} cliente=${pedido.cliente_id}`);
          if (pedido.status === 'nota_recebida') {
            agendarNotif(pedido.cliente_id, 'nota_recebida', pedido, enviarNotaRecebida);
          }
          return;
        }

        // 'modified' — verifica se o status mudou
        const statusAnterior = statusCache.get(id);
        statusCache.set(id, pedido.status);
        if (!pedidosCarregados) return;
        if (statusAnterior === pedido.status) return;

        logger.info(`[notif] Pedido ${id}: ${statusAnterior} → ${pedido.status}`);
        agendarNotif(pedido.cliente_id, pedido.status, pedido,
          (grupo) => enviarStatus(pedido.status, grupo));
      });

      if (!pedidosCarregados) {
        pedidosCarregados = true;
        logger.info(`[notif] Cache de pedidos carregado (${statusCache.size} pedidos)`);
      }
    },
    (err) => logger.error('[notif] Erro no listener de pedidos:', err.message)
  );

  // ── Listener de clientes — boas-vindas para novo cliente ──────────────────
  const clienteIds = new Set();
  let clientesCarregados = false;

  db.collection('clientes').onSnapshot(
    (snap) => {
      snap.docChanges().forEach(async (change) => {
        const cliente = change.doc.data();
        const id = String(cliente.id);

        if (change.type === 'removed') {
          clienteIds.delete(id);
          return;
        }

        if (change.type === 'added') {
          if (!clientesCarregados) {
            // Carga inicial: só registra, não envia boas-vindas
            clienteIds.add(id);
            return;
          }
          // Novo cliente adicionado após o servidor estar rodando
          if (clienteIds.has(id)) return;
          clienteIds.add(id);

          try {
            const phone = clienteToWhatsapp(cliente);
            if (!phone) return;

            await new Promise((r) => setTimeout(r, 3000)); // delay anti-flood

            const msg =
              `Olá ${cliente.nome}, seja bem-vindo(a) à *Kidex Importações*!\n\n` +
              `Estou aqui para te ajudar com seus pedidos.\n` +
              `Sempre que precisar, é só me chamar aqui no WhatsApp. 😊\n\n` +
              `Digite *Menu* para ver as opções disponíveis.`;

            await sendText(phone, msg, true); // forceNow: boas-vindas saem sempre na hora
            logger.info(`[notif] Boas-vindas enviadas → ${cliente.nome}`);
          } catch (err) {
            logger.error('[notif] Erro ao enviar boas-vindas:', err.message);
          }
        }
      });

      if (!clientesCarregados) {
        clientesCarregados = true;
        logger.info(`[notif] Cache de clientes carregado (${clienteIds.size} clientes)`);
      }
    },
    (err) => logger.error('[notif] Erro no listener de clientes:', err.message)
  );

  // ── Listener de viagens — nova viagem notifica todos os clientes ──────────
  let viagensCarregadas = false;
  const viagemIds = new Set();

  db.collection('viagens').onSnapshot(
    (snap) => {
      snap.docChanges().forEach(async (change) => {
        const viagem = change.doc.data();
        const id = String(viagem.id);

        if (change.type === 'added') {
          if (!viagensCarregadas) { viagemIds.add(id); return; }
          if (viagemIds.has(id)) return;
          viagemIds.add(id);

          logger.info(`[notif] Nova viagem ${id} — notificando todos os clientes`);
          const msg =
            `Kidex Importações\n\n` +
            `Iniciamos uma nova viagem! Aguardamos sua nota fiscal para retirar seu pedido no Paraguai.\n\n` +
            `Envie sua nota pelo WhatsApp ou acesse o portal para mais informações.`;
          await notificarTodosClientes(msg);
        }
      });

      if (!viagensCarregadas) {
        viagensCarregadas = true;
        logger.info(`[notif] Cache de viagens carregado (${viagemIds.size} viagens)`);
      }
    },
    (err) => logger.error('[notif] Erro no listener de viagens:', err.message)
  );
}

module.exports = { setupListeners };
