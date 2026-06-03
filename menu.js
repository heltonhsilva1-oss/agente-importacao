'use strict';
// Máquina de estados dos fluxos de atendimento
// Lógica e validações: regras fixas | Respostas em texto: Claude API

const { logger } = require('./logger');
const { responder, detectarIntencao } = require('./claude');
const {
  getConversa, setConversa, updateConversa, clearConversa,
  findClienteByWhatsapp, getClientesAtivos,
  getPedidosAtivos, getPedidosPendentes,
  addPendentePagamento, getPendenteAtual, resolverPendente,
  appendHistorico, getHistorico,
} = require('./firestore');
const { sendText } = require('./uazapi');

const OPERATOR_PHONE = process.env.OPERATOR_PHONE || '5511995715042';
const AGENT_PHONE    = process.env.AGENT_PHONE    || '5511961482602';
const PORTAL_URL     = process.env.PORTAL_URL     || 'https://minhaimportacao-5442a.web.app/portal';
const TIMEOUT_MS     = 10 * 60 * 1000;

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtCur(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalizePhone(phone) {
  if ((phone || '').includes('@')) return phone;
  const d = (phone || '').replace(/\D/g, '');
  return d.startsWith('55') && d.length >= 12 ? d : `55${d}`;
}

function portalLink(phone) {
  return `${PORTAL_URL}?tel=${(phone || '').replace(/[^0-9]/g, '')}`;
}

function isTimedOut(conv) {
  if (!conv?.ultima_atividade) return true;
  const last = conv.ultima_atividade.toDate
    ? conv.ultima_atividade.toDate()
    : new Date(conv.ultima_atividade);
  return Date.now() - last.getTime() > TIMEOUT_MS;
}

const STATUS_LABELS = {
  nota_recebida:             'Nota Recebida 📝',
  retirado_paraguai:         'Retirado no Paraguai 🇵🇾',
  aguardando_pgto_travessia: 'Aguardando Pgto. Travessia 💰',
  em_transito:               'Em Trânsito 🚚',
  chegou_sp:                 'Chegou em SP 🎉',
  aguardando_pgto_comissao:  'Aguardando Pgto. Comissão 💰',
  aguardando_etiqueta:       'Aguardando Etiqueta 🏷️',
  aguardando_envio:          'Aguardando Envio 📦',
  postado:                   'Postado ✅',
};

// Envia via Claude com histórico e fallback fixo
async function send(phone, instrucao, ctx = {}, fallback = '', maxTokens = 200) {
  const historico = await getHistorico(phone);
  const texto = await responder({ ...ctx, historico }, instrucao, maxTokens);
  const final = texto || fallback;
  await sendText(phone, final, true);
  // Salva no histórico de forma assíncrona (não bloqueia)
  appendHistorico(phone, 'assistant', final);
}

// Salva mensagem do cliente no histórico
function saveUserMsg(phone, body) {
  if (body?.trim()) appendHistorico(phone, 'user', body.trim());
}

// ── menu principal ────────────────────────────────────────────────────────────

async function showMenu(phone, clienteNome = '') {
  const ctx = { estado: 'menu', clienteNome };
  const instrucao = clienteNome
    ? `Cumprimente ${clienteNome} e apresente as 5 opções do menu de atendimento de forma amigável.`
    : 'Dê as boas-vindas e apresente as 5 opções do menu de atendimento de forma amigável.';
  const fallback =
    `Olá! Bem-vindo à *Kidex Importações*. 👋\n\n` +
    `1️⃣ Enviar nota fiscal\n2️⃣ Ver status do pedido\n` +
    `3️⃣ Ver o que devo\n4️⃣ Avisar que paguei\n5️⃣ Falar com o operador\n\n` +
    `Digite o número da opção.`;
  await send(phone, instrucao, ctx, fallback, 250);
  await setConversa(phone, { estado: 'menu', dados: {} });
}

// ── flow 1: enviar nota fiscal ────────────────────────────────────────────────

async function iniciarFlow1(phone) {
  await send(phone, 'Peça o nome da loja de onde veio a mercadoria.', { estado: 'flow1_loja' },
    'Por favor, me informe o nome da loja.');
  await setConversa(phone, { estado: 'flow1_loja', dados: {} });
}

async function handleFlow1(phone, estado, body, mediaUrl) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};
  saveUserMsg(phone, body);

  if (estado === 'flow1_loja') {
    if (!body?.trim()) {
      await send(phone, 'Peça o nome da loja novamente.', { estado }, 'Por favor, informe o nome da loja.');
      return;
    }
    dados.loja = body.trim();
    await send(phone, 'Confirme que recebeu o nome da loja e peça o nome do vendedor.', { estado: 'flow1_vendedor', dados },
      'Agora me informe o nome do vendedor.');
    await setConversa(phone, { estado: 'flow1_vendedor', dados });
    return;
  }

  if (estado === 'flow1_vendedor') {
    if (!body?.trim()) {
      await send(phone, 'Peça o nome do vendedor novamente.', { estado }, 'Por favor, informe o nome do vendedor.');
      return;
    }
    dados.vendedor = body.trim();
    await send(phone, 'Confirme loja e vendedor recebidos e peça a nota fiscal (foto, print ou PDF).', { estado: 'flow1_arquivo', dados },
      'Agora envie a foto, print ou PDF da nota fiscal.');
    await setConversa(phone, { estado: 'flow1_arquivo', dados });
    return;
  }

  if (estado === 'flow1_arquivo') {
    if (!mediaUrl) {
      await send(phone, 'Lembre de enviar a nota fiscal como imagem ou PDF.', { estado },
        'Por favor, envie a foto, print ou PDF da nota fiscal.');
      return;
    }
    await clearConversa(phone);
    await sendText(phone, '✅ Nota recebida! Em breve será cadastrada no sistema.', true);
    appendHistorico(phone, 'assistant', '✅ Nota recebida! Em breve será cadastrada no sistema.');
    await sendText(OPERATOR_PHONE,
      `📸 Nova nota fiscal recebida!\nCliente: ${phone}\nLoja: ${dados.loja}\nVendedor: ${dados.vendedor}`, true);
  }
}

// ── flow 2: ver status (direto, sem CPF) ──────────────────────────────────────

async function iniciarFlow2(phone, cliente) {
  const pedidos = await getPedidosAtivos(cliente.id);
  const link    = portalLink(phone);

  if (!pedidos.length) {
    await send(phone, `Informe ${cliente.nome} que não há pedidos ativos no momento.`,
      { clienteNome: cliente.nome }, `Olá ${cliente.nome}! Sem pedidos ativos no momento.`);
    return;
  }

  const listaPedidos = pedidos.map((p, i) => {
    const desc = (p.produtos || []).map(pr => pr.descricao).join(', ') || `Pedido #${p.id}`;
    return `${i + 1}. Pedido #${String(p.id).padStart(3,'0')} — ${desc} | ${STATUS_LABELS[p.status] || p.status}`;
  }).join('\n');

  const ctx = {
    estado: 'flow2_selecao',
    clienteNome: cliente.nome,
    extra: `Pedidos:\n${listaPedidos}\nLink portal (fotos e detalhes): ${link}`,
  };
  await send(phone,
    `Liste os pedidos de ${cliente.nome}. Inclua o link do portal para fotos. Peça para digitar o número do pedido ou 0 para voltar.`,
    ctx, `📦 Seus pedidos:\n${listaPedidos}\n\n🔗 Ver fotos e detalhes: ${link}\n\nDigite o número ou 0 para voltar.`, 450);

  await setConversa(phone, {
    estado: 'flow2_selecao',
    dados:  { cliente_id: cliente.id, cliente_nome: cliente.nome, pedidos_ids: pedidos.map(p => p.id) },
  });
}

async function handleFlow2Selecao(phone, body) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};
  saveUserMsg(phone, body);

  if (body === '0') { await clearConversa(phone); await showMenu(phone, dados.cliente_nome); return; }

  const pedidoId = parseInt(body);
  if (isNaN(pedidoId) || !(dados.pedidos_ids || []).includes(pedidoId)) {
    await send(phone, 'Diga que a opção é inválida e peça um número válido ou 0 para voltar.', {},
      'Opção inválida. Digite o número do pedido ou 0 para voltar.');
    return;
  }

  const pedidos = await getPedidosAtivos(dados.cliente_id);
  const pedido  = pedidos.find(p => p.id === pedidoId);
  if (!pedido) { await send(phone, 'Pedido não encontrado.', {}, 'Pedido não encontrado.'); return; }

  const prods = (pedido.produtos || []).map(pr => `${pr.descricao} (${pr.quantidade}x)`).join(', ');
  const trav  = pedido.total_travessia_brl || 0;
  const com   = pedido.total_comissao_brl  || 0;
  const link  = portalLink(phone);

  const ctx = {
    clienteNome: dados.cliente_nome,
    extra:
      `Pedido #${pedido.id} | Status: ${STATUS_LABELS[pedido.status] || pedido.status} | Produtos: ${prods}` +
      (trav > 0 ? ` | Travessia: ${fmtCur(trav)}` : '') +
      (com  > 0 ? ` | Comissão: ${fmtCur(com)}`  : '') +
      (pedido.codigo_rastreio ? ` | Rastreio: ${pedido.codigo_rastreio}` : '') +
      `\nLink portal para fotos e detalhes: ${link}`,
  };
  await send(phone, 'Apresente os detalhes do pedido e inclua o link do portal para fotos.',
    ctx, `📦 Pedido #${String(pedido.id).padStart(3,'0')}\n${STATUS_LABELS[pedido.status] || pedido.status}\n${prods}\n\n🔗 Ver detalhes: ${link}`, 350);
  await clearConversa(phone);
}

// ── flow 3: ver débitos (direto, sem CPF) ─────────────────────────────────────

async function iniciarFlow3(phone, cliente) {
  const pedidos = await getPedidosPendentes(cliente.id);
  const link    = portalLink(phone);

  if (!pedidos.length) {
    await send(phone, `Informe ${cliente.nome} que não há valores em aberto. Tom positivo.`,
      { clienteNome: cliente.nome }, `Olá ${cliente.nome}! Sem valores em aberto. 😊`);
    return;
  }

  let total = 0;
  const itens = pedidos.map(p => {
    const trav = p.total_travessia_brl || 0;
    const com  = p.total_comissao_brl  || 0;
    const desc = (p.produtos || []).map(pr => pr.descricao).join(', ') || `Pedido #${p.id}`;
    let linha  = `Pedido #${String(p.id).padStart(3,'0')} — ${desc}`;
    if (p.status === 'aguardando_pgto_travessia' && trav > 0) {
      const qtd = (p.produtos||[]).reduce((s,pr) => s + (Number(pr.quantidade)||0), 0);
      linha += ` | Travessia: ${fmtCur(trav)} (${qtd}x ${fmtCur(trav/Math.max(qtd,1))})`;
      total += trav;
    }
    if (p.status === 'aguardando_pgto_comissao' && com > 0) {
      linha += ` | Comissão: ${fmtCur(com)}`; total += com;
    }
    return linha;
  }).join('\n');

  const ctx = {
    clienteNome: cliente.nome,
    extra: `Valores em aberto:\n${itens}\nTotal: ${fmtCur(total)}\nLink portal: ${link}`,
  };
  await send(phone,
    `Apresente os valores em aberto de ${cliente.nome} com total. Inclua o link do portal. Mencione que pode pagar pelo fluxo 4.`,
    ctx, `💰 Valores em aberto:\n${itens}\n\nTotal: ${fmtCur(total)}\n\n🔗 Ver no portal: ${link}`, 400);
}

// ── flow 4: avisar pagamento ──────────────────────────────────────────────────

async function iniciarFlow4(phone, cliente) {
  // Se tem múltiplos pedidos com pagamento pendente, pergunta qual
  const pedidos = await getPedidosPendentes(cliente.id);

  if (pedidos.length > 1) {
    const lista = pedidos.map((p, i) => {
      const desc = (p.produtos || []).map(pr => pr.descricao).join(', ') || `Pedido #${p.id}`;
      const val  = p.total_travessia_brl || p.total_comissao_brl || 0;
      return `${i + 1}. Pedido #${String(p.id).padStart(3,'0')} — ${desc} (${fmtCur(val)})`;
    }).join('\n');

    await send(phone,
      `Pergunte a ${cliente.nome} qual pedido ele está pagando e liste as opções.`,
      { clienteNome: cliente.nome, extra: `Pedidos pendentes:\n${lista}` },
      `Qual pedido você está pagando?\n\n${lista}\n\nDigite o número da opção.`, 300);

    await setConversa(phone, {
      estado: 'flow4_selecao_pedido',
      dados:  { cliente_id: cliente.id, cliente_nome: cliente.nome, pedidos_ids: pedidos.map(p => p.id) },
    });
    return;
  }

  // Só um pedido pendente ou nenhum — vai direto para comprovante
  await sendText(phone, 'Por favor, envie o comprovante de pagamento.', true);
  await setConversa(phone, { estado: 'flow4_comprovante', dados: { cliente_nome: cliente.nome } });
}

async function handleFlow4(phone, estado, body, mediaUrl) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};
  saveUserMsg(phone, body);

  if (estado === 'flow4_selecao_pedido') {
    const idx = parseInt(body) - 1;
    if (isNaN(idx) || idx < 0 || idx >= (dados.pedidos_ids || []).length) {
      await send(phone, 'Opção inválida, peça para digitar o número correto.', {},
        'Opção inválida. Digite o número do pedido.');
      return;
    }
    dados.pedido_selecionado_id = dados.pedidos_ids[idx];
    await sendText(phone, 'Por favor, envie o comprovante de pagamento.', true);
    await setConversa(phone, { estado: 'flow4_comprovante', dados });
    return;
  }

  if (estado === 'flow4_comprovante') {
    if (!mediaUrl) {
      await send(phone, 'Lembre que precisa enviar o comprovante como foto ou PDF.', { estado },
        'Envie o comprovante como foto ou PDF.');
      return;
    }
    const clienteNome = dados.cliente_nome || phone;
    await clearConversa(phone);
    await sendText(phone, '✅ Comprovante recebido! Aguarde a confirmação do operador.', true);
    appendHistorico(phone, 'assistant', '✅ Comprovante recebido! Aguarde a confirmação do operador.');
    const pendenteId = await addPendentePagamento(phone, clienteNome);
    await updateConversa(OPERATOR_PHONE, { dados: { pendente_id: pendenteId, pendente_cliente_phone: phone } });
    await sendText(OPERATOR_PHONE,
      `💳 Aviso de pagamento!\nCliente: ${phone} — ${clienteNome}\nComprovante enviado na conversa do agente.\nResponda OK para confirmar ou NÃO para recusar.`, true);
    return;
  }

  if (estado === 'flow4_etiqueta') {
    if (!mediaUrl) {
      await send(phone, 'Lembre que precisa enviar a etiqueta de postagem.', { estado },
        'Por favor, envie a etiqueta de postagem.');
      return;
    }
    const clienteNome = dados.cliente_nome || phone;
    await clearConversa(phone);
    await sendText(phone, '📦 Etiqueta recebida! Em breve sua encomenda será despachada.', true);
    appendHistorico(phone, 'assistant', '📦 Etiqueta recebida! Em breve sua encomenda será despachada.');
    await sendText(OPERATOR_PHONE,
      `🏷️ Etiqueta recebida!\nCliente: ${phone} — ${clienteNome}\nEtiqueta enviada na conversa do agente.`, true);
  }
}

// ── confirmação de entrega (SIM / NÃO) ───────────────────────────────────────

async function handleConfirmacaoEntrega(phone, body) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};
  const upper = (body || '').trim().toUpperCase();

  saveUserMsg(phone, body);

  if (upper === 'SIM' || upper === '1') {
    await sendText(phone, '🎉 Que ótimo! Obrigado por confirmar. Qualquer coisa estamos aqui!', true);
    appendHistorico(phone, 'assistant', '🎉 Que ótimo! Obrigado por confirmar.');
    // Marca pedido como entrega confirmada no Firestore
    if (dados.pedido_id) {
      const { getFirestore, FieldValue } = require('firebase-admin/firestore');
      const snap = await getFirestore().collection('pedidos').where('id', '==', Number(dados.pedido_id)).limit(1).get();
      if (!snap.empty) await snap.docs[0].ref.update({ entrega_confirmada: true });
    }
  } else if (upper === 'NÃO' || upper === 'NAO' || upper === '2') {
    await sendText(phone, '😟 Poxa, lamentamos! Vou avisar o operador para resolver. Aguarde o contato.', true);
    appendHistorico(phone, 'assistant', '😟 Vou avisar o operador para resolver.');
    await sendText(OPERATOR_PHONE,
      `⚠️ Cliente ${phone} reportou que NÃO recebeu o pedido #${dados.pedido_id || '?'}. Verificar!`, true);
  } else {
    await sendText(phone, 'Por favor, responda SIM ou NÃO.', true);
    return; // mantém estado
  }

  await clearConversa(phone);
}

// ── operador: OK / NÃO / BROADCAST ───────────────────────────────────────────

async function handleOperadorResposta(body) {
  const upper = (body || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Broadcast — operador manda "AVISO: mensagem" ou "TODOS: mensagem"
  const broadcastMatch = body.match(/^(?:AVISO|TODOS):\s*(.+)/si);
  if (broadcastMatch) {
    const mensagem = broadcastMatch[1].trim();
    const clientes = await getClientesAtivos();
    let enviados = 0;
    for (const c of clientes) {
      const digits = (c.telefone || '').replace(/\D/g, '');
      if (!digits || digits.length < 10) continue;
      const tel = digits.startsWith('55') ? digits : `55${digits}`;
      try {
        await sendText(tel, `📢 *Kidex Importações*\n\n${mensagem}`, true);
        enviados++;
        await new Promise(r => setTimeout(r, 500)); // delay anti-spam
      } catch (_) {}
    }
    await sendText(OPERATOR_PHONE, `✅ Broadcast enviado para ${enviados} cliente(s).`, true);
    return true;
  }

  // Confirmação de pagamento OK / NÃO
  const confirmado = upper === 'OK';
  const recusado   = upper === 'NAO' || upper === 'NÃO';
  if (!confirmado && !recusado) return false;

  const pendente = await getPendenteAtual(OPERATOR_PHONE);
  if (!pendente) {
    await sendText(OPERATOR_PHONE, 'Nenhum pagamento pendente de confirmação.', true);
    return true;
  }
  await resolverPendente(pendente.id, confirmado);

  if (confirmado) {
    await sendText(pendente.cliente_numero,
      '✅ Pagamento confirmado! Em breve você receberá as próximas instruções.', true);
  } else {
    await send(pendente.cliente_numero,
      'Informe que não foi possível confirmar o pagamento e peça para entrar em contato.',
      {}, '❌ Pagamento não confirmado. Entre em contato com o operador.');
  }
  await updateConversa(OPERATOR_PHONE, { dados: {} });
  return true;
}

// ── roteador principal ────────────────────────────────────────────────────────

async function handleMessage(phone, tipo, body, mediaUrl, mimeType) {
  const normalPhone = normalizePhone(phone);

  // Mensagens do operador
  if (normalPhone === OPERATOR_PHONE) {
    await handleOperadorResposta(body);
    return;
  }

  // Verifica se número está cadastrado
  const clienteCadastrado = await findClienteByWhatsapp(normalPhone);
  if (!clienteCadastrado) {
    logger.info(`[menu] Número não cadastrado ignorado: ${normalPhone}`);
    return;
  }

  // Timeout — reinicia o fluxo
  const conv = await getConversa(normalPhone);
  if (conv && !['idle','menu'].includes(conv.estado) && isTimedOut(conv)) {
    await send(normalPhone, 'Informe que a sessão expirou e vai reiniciar.',
      {}, 'Sua sessão expirou. Vou reiniciar o atendimento.');
    await clearConversa(normalPhone);
  }

  const conv2    = await getConversa(normalPhone) || { estado: 'idle', dados: {} };
  const estado   = conv2.estado || 'idle';
  const bodyNorm = (body || '').trim();

  // Comando global "menu"
  if (bodyNorm.toLowerCase() === 'menu') {
    saveUserMsg(normalPhone, bodyNorm);
    await showMenu(normalPhone, clienteCadastrado.nome);
    return;
  }

  // Fluxos ativos
  if (estado.startsWith('flow1_'))         { await handleFlow1(normalPhone, estado, bodyNorm, mediaUrl); return; }
  if (estado === 'flow2_selecao')          { await handleFlow2Selecao(normalPhone, bodyNorm); return; }
  if (estado.startsWith('flow4_'))        { await handleFlow4(normalPhone, estado, bodyNorm, mediaUrl); return; }

  // Estado idle/menu — seleção numérica
  if (/^[1-5]$/.test(bodyNorm)) {
    saveUserMsg(normalPhone, bodyNorm);
    switch (bodyNorm) {
      case '1': await iniciarFlow1(normalPhone); return;
      case '2': await iniciarFlow2(normalPhone, clienteCadastrado); return;
      case '3': await iniciarFlow3(normalPhone, clienteCadastrado); return;
      case '4': await iniciarFlow4(normalPhone, clienteCadastrado); return;
      case '5':
        await send(normalPhone, 'Informe que vai chamar o operador e peça para aguardar.', {},
          'Vou chamar o operador. Aguarde um momento. 👋');
        await sendText(OPERATOR_PHONE, `📞 Cliente ${normalPhone} quer falar com você.`, true);
        await clearConversa(normalPhone);
        return;
    }
  }

  // Texto livre — Claude detecta intenção
  saveUserMsg(normalPhone, bodyNorm);
  if (bodyNorm.length > 2) {
    const intencao = await detectarIntencao(bodyNorm);
    if (intencao >= 1 && intencao <= 5) {
      await handleMessage(normalPhone, 'text', String(intencao), null, null);
      return;
    }
    const historico = await getHistorico(normalPhone);
    const respostaLivre = await responder(
      { estado, historico, extra: 'O cliente enviou uma mensagem fora dos fluxos esperados.' },
      bodyNorm, 250
    );
    if (respostaLivre) {
      await sendText(normalPhone, respostaLivre, true);
      appendHistorico(normalPhone, 'assistant', respostaLivre);
      return;
    }
  }

  // Fallback
  await showMenu(normalPhone, clienteCadastrado.nome);
}

module.exports = { handleMessage, showMenu };
