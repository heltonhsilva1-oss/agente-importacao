'use strict';
// Máquina de estados dos fluxos de atendimento
// Cada função handleFlowN processa uma etapa do fluxo correspondente

const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('./logger');
const {
  getConversa,
  setConversa,
  updateConversa,
  clearConversa,
  findClienteByCpfDigitos,
  findClienteByWhatsapp,
  getPedidosAtivos,
  getPedidosPendentes,
  addPendentePagamento,
  getPendenteAtual,
  resolverPendente,
} = require('./firestore');
const { sendText, sendMedia } = require('./uazapi');

const OPERATOR_PHONE = process.env.OPERATOR_PHONE || '5511995715042';
const AGENT_PHONE = process.env.AGENT_PHONE || '5511961482602';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtCur(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normCpf(s) {
  return (s || '').replace(/\D/g, '');
}

function normalizePhone(phone) {
  // LID ou JID com sufixo (@lid, @s.whatsapp.net) → usa como está
  if ((phone || '').includes('@')) return phone;
  const d = (phone || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) return d;
  return `55${d}`;
}

function isTimedOut(conversa) {
  if (!conversa?.ultima_atividade) return true;
  const last = conversa.ultima_atividade.toDate
    ? conversa.ultima_atividade.toDate()
    : new Date(conversa.ultima_atividade);
  return Date.now() - last.getTime() > TIMEOUT_MS;
}

const STATUS_LABELS = {
  nota_recebida: 'Nota Recebida 📝',
  retirado_paraguai: 'Retirado no Paraguai 🇵🇾',
  aguardando_pgto_travessia: 'Aguardando Pgto. Travessia 💰',
  em_transito: 'Em Trânsito 🚚',
  chegou_sp: 'Chegou em SP 🎉',
  aguardando_pgto_comissao: 'Aguardando Pgto. Comissão 💰',
  aguardando_etiqueta: 'Aguardando Etiqueta 🏷️',
  aguardando_envio: 'Aguardando Envio 📦',
  postado: 'Postado ✅',
};

// ── menu principal ────────────────────────────────────────────────────────────

async function showMenu(phone) {
  const msg =
    `Olá! Bem-vindo à *Importação Minha Importação*. 👋\n\n` +
    `Como posso te ajudar?\n` +
    `1️⃣ Enviar nota fiscal\n` +
    `2️⃣ Ver status do meu pedido\n` +
    `3️⃣ Ver o que devo\n` +
    `4️⃣ Avisar que paguei\n` +
    `5️⃣ Falar com o operador\n\n` +
    `Digite o número da opção desejada.`;
  await sendText(phone, msg, true);
  await setConversa(phone, { estado: 'menu', dados: {} });
}

// ── flow 1: enviar nota fiscal ────────────────────────────────────────────────

async function iniciarFlow1(phone) {
  await sendText(phone, 'Por favor, me informe o nome da loja.', true);
  await setConversa(phone, { estado: 'flow1_loja', dados: {} });
}

async function handleFlow1(phone, estado, body, mediaUrl, mimeType) {
  const conv = await getConversa(phone);
  const dados = conv?.dados || {};

  if (estado === 'flow1_loja') {
    if (!body?.trim()) {
      await sendText(phone, 'Por favor, me informe o nome da loja.', true);
      return;
    }
    dados.loja = body.trim();
    await sendText(phone, 'Agora me informe o nome do vendedor.', true);
    await setConversa(phone, { estado: 'flow1_vendedor', dados });
    return;
  }

  if (estado === 'flow1_vendedor') {
    if (!body?.trim()) {
      await sendText(phone, 'Por favor, me informe o nome do vendedor.', true);
      return;
    }
    dados.vendedor = body.trim();
    await sendText(phone, 'Agora envie a foto, print ou PDF da nota fiscal.', true);
    await setConversa(phone, { estado: 'flow1_arquivo', dados });
    return;
  }

  if (estado === 'flow1_arquivo') {
    if (!mediaUrl) {
      await sendText(phone, 'Por favor, envie a foto, print ou PDF da nota fiscal.', true);
      return;
    }
    // Limpa estado PRIMEIRO para evitar loop caso algo falhe depois
    await clearConversa(phone);
    // Confirmação ao cliente
    await sendText(phone, '✅ Nota recebida! Em breve será cadastrada no sistema.', true);
    // Encaminhar tudo ao operador
    const msgOp =
      `📸 Nova nota fiscal recebida!\n` +
      `Cliente: ${phone}\n` +
      `Loja: ${dados.loja}\n` +
      `Vendedor: ${dados.vendedor}`;
    await sendText(OPERATOR_PHONE, msgOp, true);
    await sendMedia(OPERATOR_PHONE, mediaUrl, mimeType || 'image/jpeg', '', true);
  }
}

// ── flow 2: ver status do pedido ──────────────────────────────────────────────

async function handleFlow2(phone, estado, body) {
  const conv = await getConversa(phone);
  const dados = conv?.dados || {};

  if (estado === 'flow2_cpf') {
    const cpf = normCpf(body);
    if (cpf.length !== 11) {
      await sendText(phone, 'CPF inválido. Por favor, digite somente os 11 números do seu CPF.', true);
      return;
    }
    dados.cpf = cpf;
    await sendText(phone, 'Agora digite os 4 últimos dígitos do seu telefone.', true);
    await setConversa(phone, { estado: 'flow2_digitos', dados });
    return;
  }

  if (estado === 'flow2_digitos') {
    const digitos = (body || '').replace(/\D/g, '').slice(-4);
    if (digitos.length !== 4) {
      await sendText(phone, 'Por favor, digite somente os 4 últimos dígitos do seu telefone.', true);
      return;
    }
    const cliente = await findClienteByCpfDigitos(dados.cpf, digitos);
    if (!cliente) {
      await sendText(
        phone,
        'CPF ou telefone não encontrado. Verifique os dados e tente novamente.',
        true
      );
      await setConversa(phone, { estado: 'flow2_cpf', dados: {} });
      await sendText(phone, 'Por favor, digite seu CPF (somente números).', true);
      return;
    }
    const pedidos = await getPedidosAtivos(cliente.id);
    if (pedidos.length === 0) {
      await sendText(phone, `Olá ${cliente.nome}! Não há pedidos ativos no momento.`, true);
      await clearConversa(phone);
      return;
    }
    let msg = `📦 Seus pedidos, ${cliente.nome}:\n`;
    pedidos.forEach((p) => {
      const label = STATUS_LABELS[p.status] || p.status;
      const desc =
        (p.produtos || []).map((pr) => pr.descricao).filter(Boolean).join(', ') ||
        `Pedido #${p.id}`;
      msg += `\nPedido #${String(p.id).padStart(3, '0')} — ${desc}\nStatus: ${label}\n`;
    });
    msg += '\nDigite o número do pedido para mais detalhes ou 0 para voltar ao menu.';
    await sendText(phone, msg, true);
    dados.cliente_id = cliente.id;
    dados.cliente_nome = cliente.nome;
    dados.pedidos_ids = pedidos.map((p) => p.id);
    await setConversa(phone, { estado: 'flow2_selecao', dados });
    return;
  }

  if (estado === 'flow2_selecao') {
    if (body === '0') {
      await clearConversa(phone);
      await showMenu(phone);
      return;
    }
    const pedidoId = parseInt(body);
    if (isNaN(pedidoId) || !(dados.pedidos_ids || []).includes(pedidoId)) {
      await sendText(phone, 'Opção inválida. Digite o número do pedido ou 0 para voltar ao menu.', true);
      return;
    }
    const pedidos = await getPedidosAtivos(dados.cliente_id);
    const pedido = pedidos.find((p) => p.id === pedidoId);
    if (!pedido) {
      await sendText(phone, 'Pedido não encontrado. Tente novamente.', true);
      return;
    }
    const prods = (pedido.produtos || [])
      .map((pr) => `• ${pr.descricao} (${pr.quantidade}x)`)
      .join('\n');
    const label = STATUS_LABELS[pedido.status] || pedido.status;
    const trav = pedido.total_travessia_brl || 0;
    const com = pedido.total_comissao_brl || 0;

    let msg = `📦 Pedido #${String(pedido.id).padStart(3, '0')}\nStatus: ${label}\n\nProdutos:\n${prods}`;
    if (trav > 0) msg += `\n\nTaxa de travessia: ${fmtCur(trav)}`;
    if (com > 0) msg += `\nComissão: ${fmtCur(com)}`;
    if (pedido.codigo_rastreio) msg += `\n\nRastreio: ${pedido.codigo_rastreio}`;
    await sendText(phone, msg, true);
    await clearConversa(phone);
  }
}

// ── flow 3: ver o que devo ────────────────────────────────────────────────────

async function handleFlow3(phone, estado, body) {
  const conv = await getConversa(phone);
  const dados = conv?.dados || {};

  if (estado === 'flow3_cpf') {
    const cpf = normCpf(body);
    if (cpf.length !== 11) {
      await sendText(phone, 'CPF inválido. Por favor, digite somente os 11 números do seu CPF.', true);
      return;
    }
    dados.cpf = cpf;
    await sendText(phone, 'Agora digite os 4 últimos dígitos do seu telefone.', true);
    await setConversa(phone, { estado: 'flow3_digitos', dados });
    return;
  }

  if (estado === 'flow3_digitos') {
    const digitos = (body || '').replace(/\D/g, '').slice(-4);
    if (digitos.length !== 4) {
      await sendText(phone, 'Por favor, digite somente os 4 últimos dígitos do seu telefone.', true);
      return;
    }
    const cliente = await findClienteByCpfDigitos(dados.cpf, digitos);
    if (!cliente) {
      await sendText(
        phone,
        'CPF ou telefone não encontrado. Verifique os dados e tente novamente.',
        true
      );
      await setConversa(phone, { estado: 'flow3_cpf', dados: {} });
      await sendText(phone, 'Por favor, digite seu CPF (somente números).', true);
      return;
    }
    const pedidos = await getPedidosPendentes(cliente.id);
    if (pedidos.length === 0) {
      await sendText(phone, `Olá ${cliente.nome}! Você não tem valores em aberto no momento. 😊`, true);
      await clearConversa(phone);
      return;
    }
    let total = 0;
    let msg = `💰 Valores em aberto, ${cliente.nome}:\n`;
    for (const p of pedidos) {
      const trav = p.total_travessia_brl || 0;
      const com = p.total_comissao_brl || 0;
      const desc =
        (p.produtos || []).map((pr) => pr.descricao).filter(Boolean).join(', ') ||
        `Pedido #${p.id}`;
      msg += `\nPedido #${String(p.id).padStart(3, '0')} — ${desc}`;
      if (p.status === 'aguardando_pgto_travessia' && trav > 0) {
        const qtd = (p.produtos || []).reduce((s, pr) => s + (Number(pr.quantidade) || 0), 0);
        const travUnit = qtd > 0 ? trav / qtd : trav;
        msg += `\nTaxa de travessia: ${fmtCur(trav)} (${qtd} itens × ${fmtCur(travUnit)})`;
        total += trav;
      }
      if (p.status === 'aguardando_pgto_comissao' && com > 0) {
        msg += `\nComissão: ${fmtCur(com)}`;
        total += com;
      }
    }
    msg += `\n\n💵 Total a pagar: ${fmtCur(total)}`;
    await sendText(phone, msg, true);
    await clearConversa(phone);
  }
}

// ── flow 4: avisar pagamento ──────────────────────────────────────────────────

async function iniciarFlow4(phone) {
  await sendText(phone, 'Por favor, envie o comprovante de pagamento.', true);
  await setConversa(phone, { estado: 'flow4_comprovante', dados: {} });
}

async function handleFlow4(phone, estado, body, mediaUrl, mimeType) {
  const conv = await getConversa(phone);
  const dados = conv?.dados || {};

  if (estado === 'flow4_comprovante') {
    if (!mediaUrl) {
      await sendText(phone, 'Por favor, envie o comprovante de pagamento (foto ou PDF).', true);
      return;
    }
    // Tenta buscar o nome do cliente pelo WhatsApp
    const clienteLookup = await findClienteByWhatsapp(phone);
    const clienteNome = clienteLookup?.nome || phone;

    // Confirmação ao cliente
    await sendText(phone, '✅ Comprovante recebido! Aguarde a confirmação do operador.', true);

    // Registra o pendente e vincula à conversa do operador
    const pendenteId = await addPendentePagamento(phone, clienteNome);
    await updateConversa(OPERATOR_PHONE, {
      dados: { pendente_id: pendenteId, pendente_cliente_phone: phone },
    });

    // Notifica operador com o comprovante
    const msgOp =
      `💳 Aviso de pagamento!\n` +
      `Cliente: ${phone} — ${clienteNome}\n` +
      `Responda OK para confirmar ou NÃO para recusar.`;
    await sendText(OPERATOR_PHONE, msgOp, true);
    await sendMedia(OPERATOR_PHONE, mediaUrl, mimeType || 'image/jpeg', '', true);

    await clearConversa(phone);
    return;
  }

  if (estado === 'flow4_etiqueta') {
    if (!mediaUrl) {
      await sendText(phone, 'Por favor, envie a etiqueta de postagem.', true);
      return;
    }
    const clienteNome = dados.cliente_nome || phone;

    // Confirmação ao cliente
    await sendText(phone, '📦 Etiqueta recebida! Em breve sua encomenda será despachada.', true);

    // Encaminha etiqueta ao operador
    const msgOp = `🏷️ Etiqueta recebida!\nCliente: ${phone} — ${clienteNome}`;
    await sendText(OPERATOR_PHONE, msgOp, true);
    await sendMedia(OPERATOR_PHONE, mediaUrl, mimeType || 'image/jpeg', '', true);

    await clearConversa(phone);
  }
}

// ── resposta do operador (OK / NÃO) ──────────────────────────────────────────

async function handleOperadorResposta(body) {
  const upper = (body || '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const confirmado = upper === 'OK';
  const recusado = upper === 'NAO' || upper === 'NÃO' || upper === 'NAO';
  if (!confirmado && !recusado) return false;

  const pendente = await getPendenteAtual(OPERATOR_PHONE);
  if (!pendente) {
    await sendText(OPERATOR_PHONE, 'Nenhum pagamento pendente de confirmação no momento.', true);
    return true;
  }

  await resolverPendente(pendente.id, confirmado);

  if (confirmado) {
    await sendText(
      pendente.cliente_numero,
      '✅ Pagamento confirmado! Por favor, envie a etiqueta de postagem aqui no WhatsApp.',
      true
    );
    // Coloca cliente no estado de aguardar etiqueta
    await setConversa(pendente.cliente_numero, {
      estado: 'flow4_etiqueta',
      dados: { cliente_nome: pendente.cliente_nome },
    });
  } else {
    await sendText(
      pendente.cliente_numero,
      '❌ Não foi possível confirmar seu pagamento. Por favor, entre em contato com o operador.',
      true
    );
  }

  // Limpa o pendente atual da conversa do operador
  await updateConversa(OPERATOR_PHONE, { dados: {} });
  return true;
}

// ── Claude: detectar intenção em texto livre ──────────────────────────────────

async function detectarIntencao(texto) {
  if (!texto?.trim()) return 0;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 5,
      system:
        'Classifique a intenção do cliente de importação. Responda SOMENTE com um número:\n' +
        '1=enviar nota fiscal  2=ver status do pedido  3=ver débitos/valores\n' +
        '4=avisar pagamento realizado  5=falar com o operador  0=não identificado',
      messages: [{ role: 'user', content: texto }],
    });
    const num = parseInt((resp.content[0]?.text || '0').trim());
    return Number.isInteger(num) && num >= 0 && num <= 5 ? num : 0;
  } catch (err) {
    logger.warn('[claude] Falha ao detectar intenção:', err.message);
    return 0;
  }
}

// ── roteador principal ────────────────────────────────────────────────────────

async function handleMessage(phone, tipo, body, mediaUrl, mimeType) {
  const normalPhone = normalizePhone(phone);

  // Mensagens do próprio operador
  if (normalPhone === OPERATOR_PHONE) {
    await handleOperadorResposta(body);
    return;
  }

  // Verificar timeout — reinicia o fluxo se inativo por 10 min
  const conv = await getConversa(normalPhone);
  if (conv && !['idle', 'menu'].includes(conv.estado) && isTimedOut(conv)) {
    await sendText(normalPhone, 'Sua sessão expirou por inatividade. Vou reiniciar o atendimento.', true);
    await clearConversa(normalPhone);
  }

  // Estado atual (lê novamente caso tenha sido limpo acima)
  const conv2 = await getConversa(normalPhone) || { estado: 'idle', dados: {} };
  const estado = conv2.estado || 'idle';
  const bodyNorm = (body || '').trim();

  // Comando global "menu" sempre reinicia o menu, independente do estado
  if (bodyNorm.toLowerCase() === 'menu') {
    await showMenu(normalPhone);
    return;
  }

  // Fluxos ativos — rota para o handler correto
  if (estado.startsWith('flow1_')) {
    await handleFlow1(normalPhone, estado, bodyNorm, mediaUrl, mimeType);
    return;
  }
  if (estado.startsWith('flow2_')) {
    await handleFlow2(normalPhone, estado, bodyNorm);
    return;
  }
  if (estado.startsWith('flow3_')) {
    await handleFlow3(normalPhone, estado, bodyNorm);
    return;
  }
  if (estado.startsWith('flow4_')) {
    await handleFlow4(normalPhone, estado, bodyNorm, mediaUrl, mimeType);
    return;
  }

  // Estado idle ou menu — interpreta seleção numérica
  if (estado === 'idle' || estado === 'menu') {
    if (/^[1-5]$/.test(bodyNorm)) {
      switch (bodyNorm) {
        case '1':
          await iniciarFlow1(normalPhone);
          return;
        case '2':
          await setConversa(normalPhone, { estado: 'flow2_cpf', dados: {} });
          await sendText(normalPhone, 'Por favor, digite seu CPF (somente números).', true);
          return;
        case '3':
          await setConversa(normalPhone, { estado: 'flow3_cpf', dados: {} });
          await sendText(normalPhone, 'Por favor, digite seu CPF (somente números).', true);
          return;
        case '4':
          await iniciarFlow4(normalPhone);
          return;
        case '5':
          await sendText(normalPhone, 'Vou chamar o operador. Aguarde um momento. 👋', true);
          await sendText(OPERATOR_PHONE, `📞 Cliente ${normalPhone} quer falar com você.`, true);
          await clearConversa(normalPhone);
          return;
      }
    }

    // Texto livre — tenta detectar intenção via Claude antes de exibir o menu
    if (bodyNorm.length > 2) {
      const intencao = await detectarIntencao(bodyNorm);
      if (intencao >= 1 && intencao <= 5) {
        // Repete a rota com o número detectado
        await handleMessage(normalPhone, 'text', String(intencao), null, null);
        return;
      }
    }
  }

  // Fallback: exibe o menu
  await showMenu(normalPhone);
}

module.exports = { handleMessage, showMenu };
