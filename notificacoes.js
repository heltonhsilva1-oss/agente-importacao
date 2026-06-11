'use strict';
// Listeners Firestore em tempo real — substitui os gatilhos do Firebase Functions
// Roda dentro do servidor Express, escutando mudanças via onSnapshot

const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('./logger');
const { sendText } = require('./uazapi');
const { setConversa } = require('./firestore');
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
          if (!pedidosCarregados) {
            statusCache.set(id, pedido.status);
            return;
          }
          // Novo pedido detectado após carga inicial
          statusCache.set(id, pedido.status);
          logger.info(`[notif] Novo pedido detectado: #${pedido.id} status=${pedido.status} cliente_id=${pedido.cliente_id}`);

          if (pedido.status === 'nota_recebida') {
            try {
              const cliente = await getClienteById(pedido.cliente_id);
              if (!cliente) {
                logger.warn(`[notif] Cliente ${pedido.cliente_id} não encontrado para pedido #${pedido.id}`);
                return;
              }
              const phone = clienteToWhatsapp(cliente);
              if (!phone) {
                logger.warn(`[notif] Cliente ${cliente.nome} sem telefone válido`);
                return;
              }
              const portal = buildPortalLink(PORTAL_URL, phone);
              await sendText(phone,
                `Olá ${cliente.nome}! Recebemos sua nota fiscal.\n\n` +
                `Em breve vamos retirar seu pedido no Paraguai.\n\n` +
                `Acompanhe pelo portal: ${portal}`, true);
              logger.info(`[notif] ✅ Nota recebida notificada → ${cliente.nome} (${phone})`);
            } catch (err) {
              logger.error('[notif] Erro ao notificar nota recebida:', err.message);
            }
          }
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
            pedido.total_comissao_brl || 0,
            phone
          );

          if (msg) {
            // forceNow=true: notificações de status sempre enviam imediatamente
            await sendText(phone, msg, true);
            logger.info(`[notif] ✅ Notificado ${cliente.nome} (${phone}): ${pedido.status}`);

            // Coloca cliente no estado correto para responder diretamente sem navegar no menu
            if (pedido.status === 'aguardando_pgto_travessia' || pedido.status === 'aguardando_pgto_comissao') {
              const cobranca = getCobrancaPendente(pedido);
              if (cobranca) {
                await setConversa(phone, {
                  estado: 'flow4_comprovante',
                  dados: {
                    cliente_nome: cliente.nome,
                    pedido_selecionado_id: pedido.id,
                    pagamento_tipo: cobranca.tipo,
                    pagamento_valor: cobranca.valor,
                  },
                });
                logger.info(`[notif] Cliente ${cliente.nome} colocado no fluxo de comprovante`);
              }
            }

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
              `Olá ${cliente.nome}, seja bem-vindo(a) à *Kidex Importações*!\n\n` +
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
