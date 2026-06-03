'use strict';
// Listeners Firestore em tempo real — substitui os gatilhos do Firebase Functions
// Roda dentro do servidor Express, escutando mudanças via onSnapshot

const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { sendText } = require('./uazapi');
const { setConversa } = require('./firestore');

const AGENT_PHONE = process.env.AGENT_PHONE || '5511961482602';

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

function buildMensagemStatus(status, nome, trav, com) {
  const wa = `https://wa.me/${AGENT_PHONE}`;
  const msgs = {
    retirado_paraguai:
      `Olá ${nome}! Sua mercadoria foi retirada no Paraguai. 🇵🇾`,
    aguardando_pgto_travessia:
      `Olá ${nome}! Sua mercadoria está pronta para embarcar.\n` +
      `O valor da taxa de travessia é *${fmtCur(trav)}*.\n` +
      `Acesse o WhatsApp do agente para avisar o pagamento: ${wa}`,
    em_transito:
      `Olá ${nome}! Sua mercadoria está a caminho de São Paulo. 🚚`,
    chegou_sp:
      `Olá ${nome}! Sua mercadoria chegou em São Paulo! 🎉`,
    aguardando_pgto_comissao:
      `Olá ${nome}! Sua mercadoria chegou em SP.\n` +
      `O valor da comissão é *${fmtCur(com)}*.\n` +
      `Acesse o WhatsApp do agente para avisar o pagamento: ${wa}`,
    aguardando_etiqueta:
      `Olá ${nome}! Pagamento confirmado. Por favor, envie a etiqueta de postagem no WhatsApp do agente: ${wa}`,
    aguardando_envio:
      `Olá ${nome}! Sua etiqueta foi confirmada. Em breve sua encomenda será postada. 📦`,
    postado:
      `Olá ${nome}! Sua encomenda foi postada. Acompanhe pelo código da etiqueta que você gerou. ✅`,
  };
  return msgs[status] || null;
}

function setupListeners() {
  const db = getFirestore();

  // ── Listener de pedidos — detecta mudança de status ───────────────────────
  // Cache em memória para saber o status anterior de cada pedido
  const statusCache = new Map();
  let pedidosCarregados = false;

  db.collection('pedidos').onSnapshot(
    (snap) => {
      snap.docChanges().forEach(async (change) => {
        const pedido = change.doc.data();
        const id = String(pedido.id);

        if (change.type === 'removed') {
          statusCache.delete(id);
          return;
        }

        if (change.type === 'added') {
          // Na carga inicial só popula o cache, sem notificar
          statusCache.set(id, pedido.status);
          return;
        }

        // 'modified' — verifica se o status mudou
        const statusAnterior = statusCache.get(id);
        statusCache.set(id, pedido.status);

        if (!pedidosCarregados) return; // ignora durante carga inicial
        if (statusAnterior === pedido.status) return; // status não mudou

        logger.info(`[notif] Pedido ${id}: ${statusAnterior} → ${pedido.status}`);

        try {
          const cliente = await getClienteById(pedido.cliente_id);
          if (!cliente) {
            logger.warn(`[notif] Cliente ${pedido.cliente_id} não encontrado para pedido ${id}`);
            return;
          }

          const phone = clienteToWhatsapp(cliente);
          if (!phone) {
            logger.warn(`[notif] Cliente ${cliente.nome} sem telefone válido`);
            return;
          }

          const msg = buildMensagemStatus(
            pedido.status,
            cliente.nome,
            pedido.total_travessia_brl || 0,
            pedido.total_comissao_brl || 0
          );

          if (msg) {
            // forceNow=true: notificações de status sempre enviam imediatamente
            await sendText(phone, msg, true);
            logger.info(`[notif] ✅ Notificado ${cliente.nome} (${phone}): ${pedido.status}`);

            // Quando status = aguardando_etiqueta, coloca cliente no fluxo de envio de etiqueta
            if (pedido.status === 'aguardando_etiqueta') {
              await setConversa(phone, {
                estado: 'flow4_etiqueta',
                dados:  { cliente_nome: cliente.nome },
              });
              logger.info(`[notif] Cliente ${cliente.nome} colocado no fluxo de etiqueta`);
            }
          } else {
            logger.info(`[notif] Status ${pedido.status} sem mensagem configurada — ignorado`);
          }
        } catch (err) {
          logger.error('[notif] Erro ao notificar status:', err.message);
        }
      });

      // Marca carga inicial concluída após o primeiro snapshot completo
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
              `👋 Olá ${cliente.nome}, seja bem-vindo(a) à *Minha Importação*!\n\n` +
              `Estou aqui para te ajudar com seus pedidos.\n` +
              `Sempre que precisar, é só me chamar aqui no WhatsApp. 😊\n\n` +
              `Digite *Menu* para ver as opções disponíveis.`;

            await sendText(phone, msg);
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
}

module.exports = { setupListeners };
