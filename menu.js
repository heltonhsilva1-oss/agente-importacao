'use strict';
// Máquina de estados dos fluxos de atendimento
// Lógica e validações: regras fixas
// Linguagem e respostas em texto: Claude API

const { logger } = require('./logger');
const { responder, detectarIntencao } = require('./claude');
const {
  getConversa, setConversa, updateConversa, clearConversa,
  findClienteByCpfDigitos, findClienteByWhatsapp,
  getPedidosAtivos, getPedidosPendentes,
  addPendentePagamento, getPendenteAtual, resolverPendente,
} = require('./firestore');
const { sendText, sendMedia } = require('./uazapi');

const OPERATOR_PHONE = process.env.OPERATOR_PHONE || '5511995715042';
const AGENT_PHONE    = process.env.AGENT_PHONE    || '5511961482602';
const TIMEOUT_MS     = 10 * 60 * 1000;

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtCur(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normCpf(s) { return (s || '').replace(/\D/g, ''); }

function normalizePhone(phone) {
  if ((phone || '').includes('@')) return phone;
  const d = (phone || '').replace(/\D/g, '');
  return d.startsWith('55') && d.length >= 12 ? d : `55${d}`;
}

function isTimedOut(conv) {
  if (!conv?.ultima_atividade) return true;
  const last = conv.ultima_atividade.toDate
    ? conv.ultima_atividade.toDate()
    : new Date(conv.ultima_atividade);
  return Date.now() - last.getTime() > TIMEOUT_MS;
}

const STATUS_LABELS = {
  nota_recebida:              'Nota Recebida 📝',
  retirado_paraguai:          'Retirado no Paraguai 🇵🇾',
  aguardando_pgto_travessia:  'Aguardando Pgto. Travessia 💰',
  em_transito:                'Em Trânsito 🚚',
  chegou_sp:                  'Chegou em SP 🎉',
  aguardando_pgto_comissao:   'Aguardando Pgto. Comissão 💰',
  aguardando_etiqueta:        'Aguardando Etiqueta 🏷️',
  aguardando_envio:           'Aguardando Envio 📦',
  postado:                    'Postado ✅',
};

// Envia mensagem gerada pelo Claude ou usa fallback fixo se Claude falhar
async function send(phone, instrucao, ctx = {}, fallback = '', maxTokens = 200) {
  const texto = await responder(ctx, instrucao, maxTokens);
  await sendText(phone, texto || fallback, true);
}

// ── menu principal ────────────────────────────────────────────────────────────

async function showMenu(phone, clienteNome = '') {
  const ctx = { estado: 'menu', clienteNome };
  const instrucao = clienteNome
    ? `Cumprimente ${clienteNome} e apresente as 5 opções do menu de atendimento de forma amigável.`
    : 'Dê as boas-vindas e apresente as 5 opções do menu de atendimento de forma amigável.';
  const fallback =
    `Olá! Bem-vindo à *Minha Importação*. 👋\n\n` +
    `1️⃣ Enviar nota fiscal\n2️⃣ Ver status do pedido\n` +
    `3️⃣ Ver o que devo\n4️⃣ Avisar que paguei\n5️⃣ Falar com o operador\n\n` +
    `Digite o número da opção.`;
  await send(phone, instrucao, ctx, fallback, 250);
  await setConversa(phone, { estado: 'menu', dados: {} });
}

// ── flow 1: enviar nota fiscal ────────────────────────────────────────────────

async function iniciarFlow1(phone) {
  const ctx = { estado: 'flow1_loja' };
  await send(phone, 'Peça o nome da loja de onde veio a mercadoria.', ctx,
    'Por favor, me informe o nome da loja.');
  await setConversa(phone, { estado: 'flow1_loja', dados: {} });
}

async function handleFlow1(phone, estado, body, mediaUrl, mimeType) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};

  if (estado === 'flow1_loja') {
    if (!body?.trim()) {
      await send(phone, 'Peça o nome da loja novamente.', { estado }, 'Por favor, informe o nome da loja.');
      return;
    }
    dados.loja = body.trim();
    const ctx = { estado: 'flow1_vendedor', dados };
    await send(phone, 'Confirme que recebeu o nome da loja e peça o nome do vendedor.', ctx,
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
    const ctx = { estado: 'flow1_arquivo', dados };
    await send(phone, 'Confirme loja e vendedor recebidos e peça para enviar a nota fiscal (foto, print ou PDF).', ctx,
      'Agora envie a foto, print ou PDF da nota fiscal.');
    await setConversa(phone, { estado: 'flow1_arquivo', dados });
    return;
  }

  if (estado === 'flow1_arquivo') {
    if (!mediaUrl) {
      await send(phone, 'Lembre o cliente de enviar a nota fiscal como imagem ou PDF.', { estado },
        'Por favor, envie a foto, print ou PDF da nota fiscal.');
      return;
    }
    // Limpa estado ANTES de enviar para evitar loop
    await clearConversa(phone);
    // Confirmação fixa — não usa Claude para evitar resposta errada
    await sendText(phone, '✅ Nota recebida! Em breve será cadastrada no sistema.', true);
    // Notifica operador por texto
    await sendText(OPERATOR_PHONE,
      `📸 Nova nota fiscal recebida!\nCliente: ${phone}\nLoja: ${dados.loja}\nVendedor: ${dados.vendedor}`, true);
  }
}

// ── flow 2: ver status do pedido ──────────────────────────────────────────────

async function handleFlow2(phone, estado, body) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};

  if (estado === 'flow2_cpf') {
    const cpf = normCpf(body);
    if (cpf.length !== 11) {
      await send(phone, 'Explique que o CPF deve ter 11 dígitos e peça novamente.', { estado },
        'CPF inválido. Digite somente os 11 números do seu CPF.');
      return;
    }
    dados.cpf = cpf;
    await send(phone, 'Confirme que recebeu o CPF e peça os 4 últimos dígitos do telefone cadastrado.', { estado, dados },
      'Agora digite os 4 últimos dígitos do seu telefone.');
    await setConversa(phone, { estado: 'flow2_digitos', dados });
    return;
  }

  if (estado === 'flow2_digitos') {
    const digitos = (body || '').replace(/\D/g, '').slice(-4);
    if (digitos.length !== 4) {
      await send(phone, 'Peça apenas os 4 últimos dígitos do telefone.', { estado },
        'Digite somente os 4 últimos dígitos do seu telefone.');
      return;
    }
    const cliente = await findClienteByCpfDigitos(dados.cpf, digitos);
    if (!cliente) {
      await send(phone, 'Informe que CPF ou telefone não foram encontrados e ofereça tentar novamente.', { estado },
        'CPF ou telefone não encontrado. Verifique e tente novamente.');
      await setConversa(phone, { estado: 'flow2_cpf', dados: {} });
      return;
    }
    const pedidos = await getPedidosAtivos(cliente.id);
    if (!pedidos.length) {
      await send(phone, `Informe a ${cliente.nome} que não há pedidos ativos no momento.`,
        { estado, clienteNome: cliente.nome }, `Olá ${cliente.nome}! Sem pedidos ativos no momento.`);
      await clearConversa(phone);
      return;
    }
    // Monta lista de pedidos para o Claude formatar
    const listaPedidos = pedidos.map((p, i) => {
      const desc = (p.produtos || []).map(pr => pr.descricao).join(', ') || `Pedido #${p.id}`;
      return `${i + 1}. Pedido #${String(p.id).padStart(3,'0')} — ${desc} | Status: ${STATUS_LABELS[p.status] || p.status}`;
    }).join('\n');

    const ctx = {
      estado: 'flow2_selecao',
      clienteNome: cliente.nome,
      extra: `Pedidos ativos:\n${listaPedidos}`,
    };
    await send(phone,
      `Liste os pedidos ativos de ${cliente.nome} de forma clara e peça para digitar o número do pedido para mais detalhes ou 0 para voltar ao menu.`,
      ctx, `📦 Seus pedidos:\n${listaPedidos}\n\nDigite o número do pedido ou 0 para voltar.`, 400);
    dados.cliente_id   = cliente.id;
    dados.cliente_nome = cliente.nome;
    dados.pedidos_ids  = pedidos.map(p => p.id);
    await setConversa(phone, { estado: 'flow2_selecao', dados });
    return;
  }

  if (estado === 'flow2_selecao') {
    if (body === '0') { await clearConversa(phone); await showMenu(phone, dados.cliente_nome); return; }
    const pedidoId = parseInt(body);
    if (isNaN(pedidoId) || !(dados.pedidos_ids || []).includes(pedidoId)) {
      await send(phone, 'Diga que a opção é inválida e peça para digitar um número de pedido válido ou 0 para voltar.', {},
        'Opção inválida. Digite o número do pedido ou 0 para voltar.');
      return;
    }
    const pedidos = await getPedidosAtivos(dados.cliente_id);
    const pedido  = pedidos.find(p => p.id === pedidoId);
    if (!pedido) { await send(phone, 'Diga que o pedido não foi encontrado.', {}, 'Pedido não encontrado.'); return; }

    const prods = (pedido.produtos || []).map(pr => `${pr.descricao} (${pr.quantidade}x)`).join(', ');
    const trav  = pedido.total_travessia_brl || 0;
    const com   = pedido.total_comissao_brl  || 0;
    const ctx   = {
      clienteNome: dados.cliente_nome,
      extra: `Pedido #${pedido.id} | Status: ${STATUS_LABELS[pedido.status] || pedido.status} | Produtos: ${prods}` +
        (trav > 0 ? ` | Travessia: ${fmtCur(trav)}` : '') +
        (com  > 0 ? ` | Comissão: ${fmtCur(com)}`  : '') +
        (pedido.codigo_rastreio ? ` | Rastreio: ${pedido.codigo_rastreio}` : ''),
    };
    await send(phone, 'Apresente os detalhes deste pedido de forma clara e amigável.', ctx,
      `📦 Pedido #${String(pedido.id).padStart(3,'0')}\nStatus: ${STATUS_LABELS[pedido.status] || pedido.status}\nProdutos: ${prods}`, 300);
    await clearConversa(phone);
  }
}

// ── flow 3: ver o que devo ────────────────────────────────────────────────────

async function handleFlow3(phone, estado, body) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};

  if (estado === 'flow3_cpf') {
    const cpf = normCpf(body);
    if (cpf.length !== 11) {
      await send(phone, 'Peça o CPF com 11 dígitos.', { estado }, 'CPF inválido. Digite os 11 números.');
      return;
    }
    dados.cpf = cpf;
    await send(phone, 'Confirme CPF e peça os 4 últimos dígitos do telefone.', { estado, dados },
      'Agora os 4 últimos dígitos do seu telefone.');
    await setConversa(phone, { estado: 'flow3_digitos', dados });
    return;
  }

  if (estado === 'flow3_digitos') {
    const digitos = (body || '').replace(/\D/g, '').slice(-4);
    if (digitos.length !== 4) {
      await send(phone, 'Peça somente os 4 últimos dígitos do telefone.', { estado },
        'Digite somente os 4 últimos dígitos do telefone.');
      return;
    }
    const cliente = await findClienteByCpfDigitos(dados.cpf, digitos);
    if (!cliente) {
      await send(phone, 'Informe que os dados não foram encontrados.', { estado },
        'CPF ou telefone não encontrado. Verifique e tente novamente.');
      await setConversa(phone, { estado: 'flow3_cpf', dados: {} });
      return;
    }
    const pedidos = await getPedidosPendentes(cliente.id);
    if (!pedidos.length) {
      await send(phone, `Informe a ${cliente.nome} que não há valores em aberto. Use um tom positivo.`,
        { clienteNome: cliente.nome }, `Olá ${cliente.nome}! Sem valores em aberto. 😊`);
      await clearConversa(phone);
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
      extra: `Valores em aberto:\n${itens}\nTotal: ${fmtCur(total)}`,
    };
    await send(phone,
      `Apresente os valores em aberto de ${cliente.nome} de forma clara, incluindo o total. Mencione que pode pagar pelo fluxo 4.`,
      ctx, `💰 Valores em aberto:\n${itens}\n\nTotal: ${fmtCur(total)}`, 400);
    await clearConversa(phone);
  }
}

// ── flow 4: avisar pagamento ──────────────────────────────────────────────────

async function iniciarFlow4(phone) {
  await send(phone, 'Peça para o cliente enviar o comprovante de pagamento (foto ou PDF).', { estado: 'flow4_comprovante' },
    'Por favor, envie o comprovante de pagamento.');
  await setConversa(phone, { estado: 'flow4_comprovante', dados: {} });
}

async function handleFlow4(phone, estado, body, mediaUrl, mimeType) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};

  if (estado === 'flow4_comprovante') {
    if (!mediaUrl) {
      await send(phone, 'Lembre que precisa enviar o comprovante como foto ou PDF.', { estado },
        'Envie o comprovante como foto ou PDF.');
      return;
    }
    const clienteLookup = await findClienteByWhatsapp(phone);
    const clienteNome   = clienteLookup?.nome || phone;
    await clearConversa(phone);
    await sendText(phone, '✅ Comprovante recebido! Aguarde a confirmação do operador.', true);
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
    await sendText(OPERATOR_PHONE, `🏷️ Etiqueta recebida!\nCliente: ${phone} — ${clienteNome}\nEtiqueta enviada na conversa do agente.`, true);
  }
}

// ── operador: OK / NÃO ────────────────────────────────────────────────────────

async function handleOperadorResposta(body) {
  const upper = (body || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
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
    await send(pendente.cliente_numero,
      'Informe que o pagamento foi confirmado e peça para enviar a etiqueta de postagem.',
      {}, '✅ Pagamento confirmado! Envie a etiqueta de postagem aqui no WhatsApp.');
    await setConversa(pendente.cliente_numero, {
      estado: 'flow4_etiqueta',
      dados:  { cliente_nome: pendente.cliente_nome },
    });
  } else {
    await send(pendente.cliente_numero,
      'Informe que não foi possível confirmar o pagamento e peça para entrar em contato com o operador.',
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

  // Timeout — reinicia o fluxo
  const conv = await getConversa(normalPhone);
  if (conv && !['idle','menu'].includes(conv.estado) && isTimedOut(conv)) {
    await send(normalPhone,
      'Informe que a sessão expirou por inatividade e que vai reiniciar o atendimento.',
      {}, 'Sua sessão expirou. Vou reiniciar o atendimento.');
    await clearConversa(normalPhone);
  }

  const conv2  = await getConversa(normalPhone) || { estado: 'idle', dados: {} };
  const estado = conv2.estado || 'idle';
  const bodyNorm = (body || '').trim();

  // Comando global "menu"
  if (bodyNorm.toLowerCase() === 'menu') {
    const clienteNome = conv2.dados?.cliente_nome || '';
    await showMenu(normalPhone, clienteNome);
    return;
  }

  // Fluxos ativos
  if (estado.startsWith('flow1_')) { await handleFlow1(normalPhone, estado, bodyNorm, mediaUrl, mimeType); return; }
  if (estado.startsWith('flow2_')) { await handleFlow2(normalPhone, estado, bodyNorm); return; }
  if (estado.startsWith('flow3_')) { await handleFlow3(normalPhone, estado, bodyNorm); return; }
  if (estado.startsWith('flow4_')) { await handleFlow4(normalPhone, estado, bodyNorm, mediaUrl, mimeType); return; }

  // Estado idle/menu — interpreta seleção ou texto livre
  if (/^[1-5]$/.test(bodyNorm)) {
    switch (bodyNorm) {
      case '1': await iniciarFlow1(normalPhone); return;
      case '2':
        await setConversa(normalPhone, { estado: 'flow2_cpf', dados: {} });
        await send(normalPhone, 'Peça o CPF do cliente (somente números).', { estado: 'flow2_cpf' },
          'Digite seu CPF (somente números).');
        return;
      case '3':
        await setConversa(normalPhone, { estado: 'flow3_cpf', dados: {} });
        await send(normalPhone, 'Peça o CPF do cliente (somente números).', { estado: 'flow3_cpf' },
          'Digite seu CPF (somente números).');
        return;
      case '4': await iniciarFlow4(normalPhone); return;
      case '5':
        await send(normalPhone, 'Informe que vai chamar o operador e peça para aguardar.', {},
          'Vou chamar o operador. Aguarde um momento. 👋');
        await sendText(OPERATOR_PHONE, `📞 Cliente ${normalPhone} quer falar com você.`, true);
        await clearConversa(normalPhone);
        return;
    }
  }

  // Texto livre — Claude detecta intenção
  if (bodyNorm.length > 2) {
    const intencao = await detectarIntencao(bodyNorm);
    if (intencao >= 1 && intencao <= 5) {
      await handleMessage(normalPhone, 'text', String(intencao), null, null);
      return;
    }
    // Claude responde a perguntas fora do script
    const respostaLivre = await responder(
      { estado, extra: 'O cliente enviou uma mensagem fora dos fluxos esperados.' },
      bodyNorm, 250
    );
    if (respostaLivre) {
      await sendText(normalPhone, respostaLivre, true);
      return;
    }
  }

  // Fallback: mostra menu
  await showMenu(normalPhone);
}

module.exports = { handleMessage, showMenu };
