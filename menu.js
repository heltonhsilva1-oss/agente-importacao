'use strict';
// Máquina de estados dos fluxos de atendimento
// Lógica e validações: regras fixas | Respostas em texto: Claude API

const { logger } = require('./logger');
const { responder, detectarIntencao, extrairProdutosNota } = require('./claude');
const { salvarNotaRecebida } = require('./nota-storage');
const {
  getConversa, setConversa, clearConversa,
  findClienteByWhatsapp, getClientesAtivos,
  getPedidosAtivos, getPedidosPendentes,
  getPendentesPagamento, reservarPendente,
  finalizarPendente, devolverPendenteFila, confirmarPagamentoPedido,
  appendHistorico, getHistorico, criarRascunhoPedido,
  getConfiguracoes, getViagemMaisRecente,
} = require('./firestore');
const { sendText } = require('./uazapi');
const { getCobrancaPendente } = require('./pagamentos');
const { buildPortalLink } = require('./portal-access');
const { statusMensalidadeEfetivo } = require('./mensalidade');
const { padronizarNomeLoja } = require('./lojas');

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
  return buildPortalLink(PORTAL_URL, phone);
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
    ? `Cumprimente ${clienteNome} e apresente as 6 opções do menu de atendimento de forma amigável.`
    : 'Dê as boas-vindas e apresente as 6 opções do menu de atendimento de forma amigável.';
  const fallback =
    `Olá! Bem-vindo à *Kidex Importações*. 👋\n\n` +
    `1️⃣ Enviar nota fiscal\n2️⃣ Ver status do pedido\n` +
    `3️⃣ Ver o que devo\n4️⃣ Pagar taxa ou comissão\n` +
    `5️⃣ Enviar etiqueta de postagem\n6️⃣ Falar com o operador\n\n` +
    `Digite o número da opção.`;
  await send(phone, instrucao, ctx, fallback, 250);
  await setConversa(phone, { estado: 'menu', dados: {} });
}

// ── flow 1: enviar nota fiscal ────────────────────────────────────────────────

// Extrai ano/mês/dia/hora/minuto/dia-da-semana no horário de Brasília, sem
// depender do fuso do servidor onde o Node roda (Railway costuma rodar em UTC).
function componentesSaoPaulo(instante = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  const partes = Object.fromEntries(fmt.formatToParts(instante).map(p => [p.type, p.value]));
  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(partes.year),
    month: Number(partes.month),
    day: Number(partes.day),
    weekday: DIAS[partes.weekday],
    hour: partes.hour === '24' ? 0 : Number(partes.hour),
    minute: Number(partes.minute),
  };
}

// Constrói o instante absoluto (correto em qualquer fuso) de uma data/hora
// falada em horário de Brasília. Brasil não tem mais horário de verão desde
// 2019, então o offset -03:00 é fixo o ano todo.
function instanteSaoPaulo(year, month, day, hour, minute) {
  const pad = n => String(n).padStart(2, '0');
  return new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-03:00`);
}

// Calcula o instante do último corte (dia + hora configurados, em horário de
// Brasília) que já passou. Ex: corte = sexta 11h, hoje é quarta → sexta anterior.
function calcUltimoCorte(horarioCorte, diaCorte, instanteAgora = new Date()) {
  const [hS, mS] = String(horarioCorte || '11:00').split(':');
  const hC = parseInt(hS, 10) || 0;
  const mC = parseInt(mS, 10) || 0;
  const diaAlvo = Number.isInteger(diaCorte) ? diaCorte : 5;

  const agora = componentesSaoPaulo(instanteAgora);
  const diasAtras = (agora.weekday - diaAlvo + 7) % 7;

  // Rola a data (ano/mês/dia) `diasAtras` dias para trás, em UTC puro — sem
  // ambiguidade de fuso — e então monta o instante do corte nesse dia.
  const baseUtc = new Date(Date.UTC(agora.year, agora.month - 1, agora.day));
  baseUtc.setUTCDate(baseUtc.getUTCDate() - diasAtras);
  let candidato = instanteSaoPaulo(baseUtc.getUTCFullYear(), baseUtc.getUTCMonth() + 1, baseUtc.getUTCDate(), hC, mC);

  // Se hoje é o dia do corte mas o horário ainda não chegou, o "último corte"
  // foi o da semana anterior, não o de hoje. Subtrai 7 dias em milissegundos
  // (seguro: Brasil não tem DST, então 7 dias = 7×24h sempre).
  if (candidato > instanteAgora) candidato = new Date(candidato.getTime() - 7 * 24 * 60 * 60 * 1000);
  return candidato;
}

// A viagem atual só aceita notas se foi aberta DEPOIS do último corte que já
// passou. Fecha automaticamente no dia/hora configurado; só reabre quando o
// operador cria uma viagem nova — não depende de status "concluída".
async function estaAceitandoNotas() {
  const [cfg, viagem] = await Promise.all([getConfiguracoes(), getViagemMaisRecente()]);
  const ultimoCorte = calcUltimoCorte(cfg.horarioCorte, cfg.diaCorte);
  if (!viagem) return false;

  // criado_em é o mais preciso (timestamp completo). Viagens criadas antes
  // desta funcionalidade não têm esse campo — usa data_saida (só a data, sem
  // hora) como aproximação, tratada como meia-noite em Brasília, para não
  // bloquear uma viagem legada que já estava legitimamente em andamento. Sem
  // nenhuma das duas referências, não bloqueia (evita falso bloqueio por dado ausente).
  let dataRef = null;
  if (viagem.criado_em) {
    dataRef = new Date(viagem.criado_em);
  } else if (viagem.data_saida) {
    const [y, m, d] = String(viagem.data_saida).split('-').map(Number);
    if (y && m && d) dataRef = instanteSaoPaulo(y, m, d, 0, 0);
  }
  if (!dataRef) return true;

  return !isNaN(dataRef) && dataRef >= ultimoCorte;
}

async function iniciarFlow1(phone) {
  if (!(await estaAceitandoNotas())) {
    await sendText(phone,
      'No momento não estamos mais aceitando notas fiscais — o corte desta semana já passou. ' +
      'Aguarde a próxima viagem abrir e envie sua nota assim que avisarmos por aqui.',
      true);
    return;
  }

  await send(phone, 'Peça o nome da loja de onde veio a mercadoria.', { estado: 'flow1_loja' },
    'Por favor, me informe o nome da loja.');
  await setConversa(phone, { estado: 'flow1_loja', dados: {} });
}

async function handleFlow1(phone, estado, body, mediaUrl, mimeType, rawContent = null) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};
  saveUserMsg(phone, body);

  if (estado === 'flow1_loja') {
    if (!body?.trim()) {
      await send(phone, 'Peça o nome da loja novamente.', { estado }, 'Por favor, informe o nome da loja.');
      return;
    }
    dados.loja = padronizarNomeLoja(body);
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

    // Snapshot dos dados desta nota — o processamento é assíncrono e não pode
    // depender de `dados`, que será reaproveitado se houver nota de outra loja.
    const nota = { loja: dados.loja ?? '', vendedor: dados.vendedor ?? '', mediaUrl, mimeType, rawContent };
    const numeroNota = (dados.count || 0) + 1;

    // Continua o fluxo: pergunta se há nota de outra loja (não encerra)
    await setConversa(phone, { estado: 'flow1_mais', dados: { count: numeroNota } });
    await sendText(phone,
      `Nota ${numeroNota} recebida! Estamos processando.\n\nVocê tem nota de *outra loja* nesta retirada? Responda *SIM* para enviar outra ou *NÃO* para finalizar.`,
      true);
    appendHistorico(phone, 'assistant', `Nota ${numeroNota} recebida. Tem nota de outra loja? SIM/NÃO`);

    // Extrai produtos via Claude Vision (não bloqueia resposta ao cliente)
    extrairProdutosNota(nota.mediaUrl, nota.mimeType, nota.rawContent).then(async resultado => {
      try {
        // resultado pode ser: { produtos: [...] } | { erro: 'url_expirada'|'formato_nao_suportado' } | null
        const erroTipo       = resultado?.erro ?? null;
        const produtos       = resultado?.produtos ?? [];
        const extracaoStatus = !resultado || erroTipo ? 'erro' : produtos.length === 0 ? 'parcial' : 'ok';

        // Resolve cliente pelo número WhatsApp (trata nono dígito e prefixo 55)
        const clienteMatch = await findClienteByWhatsapp(phone);

        let fotoNota = null;
        if (resultado?.arquivo?.buffer) {
          try {
            fotoNota = await salvarNotaRecebida(resultado.arquivo.buffer, {
              mimeType: resultado.arquivo.mimeType,
              phone,
              loja: nota.loja,
            });
          } catch (storageErr) {
            logger.error('[menu] não foi possível arquivar nota:', storageErr.message);
          }
        }

        const rascunhoId = await criarRascunhoPedido({
          cliente_phone:      phone,
          cliente_id:         clienteMatch?.id ?? null,
          cliente_nome:       clienteMatch?.nome ?? phone,
          nome_loja:          nota.loja,
          nome_vendedor:      nota.vendedor,
          foto_nota_url:      fotoNota?.url || nota.mediaUrl,
          foto_nota:          fotoNota,
          produtos,
          extracao_status:    extracaoStatus,
        });

        const prodMsg = extracaoStatus === 'ok'
          ? `${produtos.length} produto(s) extraído(s)`
          : extracaoStatus === 'parcial'
            ? 'nenhum produto identificado — revisão manual necessária'
            : erroTipo === 'url_expirada'
              ? 'URL da mídia expirada — cliente deve reenviar a nota'
              : erroTipo === 'formato_nao_suportado'
                ? `formato não suportado (${resultado?.sniffed || resultado?.rawType || '?'}) — cliente deve enviar JPG/PNG/PDF`
                : 'erro na extração — revisão manual necessária';

        // Avisa cliente se o formato não for suportado
        if (erroTipo === 'formato_nao_suportado') {
          await sendText(phone,
            `Não conseguimos ler a nota ${numeroNota} (loja ${nota.loja}). Por favor, reenvie em formato JPG, PNG ou PDF.`,
            true);
        } else if (erroTipo === 'url_expirada') {
          await sendText(phone,
            `A nota ${numeroNota} (loja ${nota.loja}) expirou antes de ser processada. Por favor, reenvie.`,
            true);
        }

        await sendText(OPERATOR_PHONE,
          `Nova nota fiscal recebida! (nota ${numeroNota})\nCliente: ${phone}\nLoja: ${nota.loja}\nVendedor: ${nota.vendedor}\nResultado: ${prodMsg}\nID rascunho: ${rascunhoId}`,
          true);
      } catch (err) {
        logger.error('[menu] flow1_arquivo pos-extracao erro:', err.message);
      }
    });
    return;
  }

  if (estado === 'flow1_mais') {
    const resposta = (body || '').trim().toLowerCase();
    const count    = dados.count || 0;
    const sim = /^(sim|s|outra|mais|adicionar|tem|quero|1)\b/.test(resposta) || resposta === 'sim';
    const nao = /^(n[aã]o|nao|n|finalizar|pronto|acabou|encerrar|fim|so isso|s[oó] isso|0)\b/.test(resposta);

    // Se o cliente já mandou outra foto direto, orienta a informar a loja primeiro
    if (mediaUrl && !nao) {
      await sendText(phone,
        'Para registrar a nota da outra loja, me informe primeiro o *nome da loja*.',
        true);
      await setConversa(phone, { estado: 'flow1_loja', dados: { count } });
      return;
    }

    if (sim) {
      await send(phone, 'Confirme que vai registrar a nota de outra loja e peça o nome dessa loja.',
        { estado: 'flow1_loja', dados: { count } },
        'Certo! Qual o nome da *outra loja*?');
      await setConversa(phone, { estado: 'flow1_loja', dados: { count } });
      return;
    }

    if (nao) {
      await clearConversa(phone);
      await sendText(phone,
        `Perfeito! Recebemos ${count} nota${count !== 1 ? 's' : ''} nesta retirada. Já estamos processando tudo. Obrigado!`,
        true);
      appendHistorico(phone, 'assistant', `Retirada finalizada com ${count} nota(s).`);
      return;
    }

    // Não entendeu a resposta
    await sendText(phone,
      'Não entendi. Você tem nota de *outra loja*? Responda *SIM* para enviar outra ou *NÃO* para finalizar.',
      true);
    return;
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
    ctx, `Seus pedidos:\n${listaPedidos}\n\nVer fotos e detalhes: ${link}\n\nDigite o número ou 0 para voltar.`, 450);

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
    ctx, `Pedido #${String(pedido.id).padStart(3,'0')}\n${STATUS_LABELS[pedido.status] || pedido.status}\n${prods}\n\nVer detalhes: ${link}`, 350);
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
    `Apresente os valores em aberto de ${cliente.nome} com total. Informe que o pagamento deve ser feito pelo link do portal e será confirmado automaticamente.`,
    ctx, `Valores em aberto:\n${itens}\n\nTotal: ${fmtCur(total)}\n\nPague pelo portal (confirmação automática): ${link}`, 400);
}

// ── flow 4: pagar pelo portal ─────────────────────────────────────────────────

async function iniciarFlow4(phone, cliente) {
  const pedidos = await getPedidosPendentes(cliente.id);

  if (!pedidos.length) {
    await send(phone, `Informe ${cliente.nome} que não há pagamentos pendentes.`,
      { clienteNome: cliente.nome }, `Olá ${cliente.nome}! Não há pagamentos pendentes no momento.`);
    await clearConversa(phone);
    return;
  }

  const link = portalLink(phone);
  const lista = pedidos.map((p) => {
    const cobranca = getCobrancaPendente(p);
    const tipoLabel = cobranca?.tipo === 'travessia' ? 'Taxa de travessia' : 'Comissão';
    return `Pedido #${String(p.id).padStart(3, '0')} — ${tipoLabel}: ${fmtCur(cobranca?.valor)}`;
  }).join('\n');
  await send(phone,
    `Informe os pagamentos pendentes de ${cliente.nome}. Oriente a pagar exclusivamente pelo link do portal. Diga que a confirmação é automática e que não precisa enviar comprovante.`,
    { clienteNome: cliente.nome, extra: `Pagamentos pendentes:\n${lista}\nLink: ${link}` },
    `Pagamentos pendentes:\n${lista}\n\nPague pelo link abaixo:\n${link}\n\nA confirmação é automática. Não precisa enviar comprovante.`, 350);
  await clearConversa(phone);
}

async function handleFlow4(phone, estado, body, mediaUrl) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};
  saveUserMsg(phone, body);

  // Conversas iniciadas antes da mudança deixam de solicitar comprovante.
  if (estado === 'flow4_selecao_pedido' || estado === 'flow4_comprovante') {
    await clearConversa(phone);
    const cliente = await findClienteByWhatsapp(phone);
    if (cliente) await iniciarFlow4(phone, cliente);
    return;
  }

  if (estado === 'flow4_etiqueta') {
    if (!mediaUrl) {
      const clienteEtiq = await findClienteByWhatsapp(phone);
      if (clienteEtiq) {
        const pedidosAtivos = await getPedidosAtivos(clienteEtiq.id);
        const aindaAguardando = pedidosAtivos.some(p => p.status === 'aguardando_etiqueta');
        if (!aindaAguardando) {
          await clearConversa(phone);
          await showMenu(phone, clienteEtiq.nome);
          return;
        }
      }
      await send(phone, 'Lembre que precisa enviar a etiqueta de postagem.', { estado },
        'Por favor, envie a etiqueta de postagem.');
      return;
    }
    const clienteEtiqMidia = await findClienteByWhatsapp(phone);
    if (clienteEtiqMidia) {
      const pedidosAtivos = await getPedidosAtivos(clienteEtiqMidia.id);
      const aindaAguardando = pedidosAtivos.some(p => p.status === 'aguardando_etiqueta');
      if (!aindaAguardando) {
        await clearConversa(phone);
        await showMenu(phone, clienteEtiqMidia.nome);
        return;
      }
    }
    const clienteNome = dados.cliente_nome || phone;
    await clearConversa(phone);
    await sendText(phone, 'Etiqueta recebida! Em breve sua encomenda será despachada.', true);
    appendHistorico(phone, 'assistant', 'Etiqueta recebida! Em breve sua encomenda será despachada.');
    await sendText(OPERATOR_PHONE,
      `Etiqueta recebida!\nCliente: ${phone} — ${clienteNome}\nEtiqueta enviada na conversa do agente.`, true);
  }
}

// ── confirmação de entrega (SIM / NÃO) ───────────────────────────────────────

async function handleConfirmacaoEntrega(phone, body) {
  const conv  = await getConversa(phone);
  const dados = conv?.dados || {};
  const upper = (body || '').trim().toUpperCase();

  saveUserMsg(phone, body);

  if (upper === 'SIM' || upper === '1') {
    await sendText(phone, 'Que otimo! Obrigado por confirmar. Qualquer coisa estamos aqui!', true);
    appendHistorico(phone, 'assistant', 'Que otimo! Obrigado por confirmar.');
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

// ── operador: fila de pagamentos / broadcast ─────────────────────────────────

function parseComandoFila(body) {
  const normalizado = (body || '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (normalizado === 'FILA' || normalizado === 'PENDENTES') {
    return { acao: 'listar', posicao: null };
  }

  const match = normalizado.match(/^(OK|NAO)(?:\s+(\d+))?$/);
  if (!match) return null;
  return {
    acao: match[1] === 'OK' ? 'confirmar' : 'recusar',
    posicao: match[2] ? Number(match[2]) : 1,
  };
}

function formatarFila(pendentes) {
  if (!pendentes.length) return 'Nenhum pagamento pendente de confirmação.';

  const itens = pendentes.map((p, index) =>
    `${index + 1}. Pedido #${p.pedido_id} — ${p.cliente_nome || p.cliente_numero}\n` +
    `   ${p.tipo === 'travessia' ? 'Travessia' : 'Comissão'}: ${fmtCur(p.valor)}`
  ).join('\n\n');

  return `Pagamentos aguardando confirmação:\n\n${itens}\n\n` +
    `Envie OK para confirmar o primeiro, NÃO para recusar o primeiro, ` +
    `ou use OK 2 / NÃO 2 para escolher outro número.`;
}

// Aviso único (não recorrente) para clientes já vencidos no momento em que o
// bug do jobAvisoVip foi corrigido — explica o vencimento e a falha no
// sistema que impediu o aviso automático antes. Marca cada cliente avisado
// para nunca reenviar, mesmo se o comando for disparado de novo.
async function jobAvisoErroSistemicoMensalidade() {
  const { getFirestore } = require('firebase-admin/firestore');
  const db = getFirestore();
  const snap = await db.collection('clientes').get();
  let enviados = 0;
  const nomes = [];
  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.aviso_erro_sistemico_mensalidade_enviado) continue;
    if (statusMensalidadeEfetivo(c) !== 'vencida') continue;
    const phone = normalizePhone(c.telefone || '');
    if (!phone || phone.length < 12) continue;
    const dia = c.data_vencimento_mensalidade;
    const msg =
      `Olá ${c.nome}! Identificamos que sua mensalidade VIP venceu no dia ${dia} e está em aberto.\n\n` +
      `Por uma falha no nosso sistema, o aviso de cobrança não foi enviado antes do vencimento — pedimos desculpas pelo transtorno.\n\n` +
      `Por favor, regularize o pagamento assim que possível para continuar com o atendimento normalmente.`;
    try {
      await sendText(phone, msg, true);
      await doc.ref.update({ aviso_erro_sistemico_mensalidade_enviado: true });
      enviados++;
      nomes.push(c.nome);
      await new Promise(r => setTimeout(r, 500)); // delay anti-spam
    } catch (err) {
      logger.error(`[menu] falha ao avisar mensalidade vencida (${c.nome}):`, err.message);
    }
  }
  return { enviados, nomes };
}

async function handleOperadorResposta(body) {
  // Comando único do operador: dispara o aviso de erro sistêmico acima.
  const normalizadoCmd = (body || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (normalizadoCmd === 'AVISAR VENCIDAS') {
    const resultado = await jobAvisoErroSistemicoMensalidade();
    await sendText(OPERATOR_PHONE,
      resultado.enviados > 0
        ? `Aviso enviado para ${resultado.enviados} cliente(s) com mensalidade vencida:\n${resultado.nomes.join(', ')}`
        : 'Nenhum cliente com mensalidade vencida pendente de aviso (todos já foram avisados ou nenhum está vencido).',
      true);
    return true;
  }

  // Broadcast — operador manda "AVISO: mensagem" ou "TODOS: mensagem"
  const broadcastMatch = (body || '').match(/^(?:AVISO|TODOS):\s*(.+)/si);
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
    await sendText(OPERATOR_PHONE, `Broadcast enviado para ${enviados} cliente(s).`, true);
    return true;
  }

  const comando = parseComandoFila(body);
  if (!comando) return false;

  const pendentes = await getPendentesPagamento();
  if (comando.acao === 'listar') {
    await sendText(OPERATOR_PHONE, formatarFila(pendentes), true);
    return true;
  }

  const posicao = comando.posicao;
  if (!Number.isInteger(posicao) || posicao < 1 || posicao > pendentes.length) {
    await sendText(OPERATOR_PHONE,
      `Não existe o item ${posicao} na fila atual.\n\n${formatarFila(pendentes)}`, true);
    return true;
  }

  const pendente = await reservarPendente(pendentes[posicao - 1].id);
  if (!pendente) {
    await sendText(OPERATOR_PHONE,
      'Esse pagamento já foi processado. Envie FILA para atualizar a lista.', true);
    return true;
  }

  if (!pendente.pedido_id || !Number.isFinite(Number(pendente.pedido_id))) {
    await finalizarPendente(pendente.id, 'corrompido');
    await sendText(OPERATOR_PHONE,
      'Registro corrompido removido da fila (pedido_id inválido). Envie FILA para ver os demais.', true);
    return true;
  }

  if (comando.acao === 'recusar') {
    await finalizarPendente(pendente.id, 'recusado');
    await send(pendente.cliente_numero,
      'Informe que não foi possível confirmar o pagamento e peça para entrar em contato.',
      {}, 'Pagamento não confirmado. Entre em contato com o operador.');
    await sendText(OPERATOR_PHONE,
      `Pagamento do pedido #${pendente.pedido_id} recusado.`, true);
    return true;
  }

  const resultado = await confirmarPagamentoPedido(pendente.pedido_id, pendente.tipo);
  if (!resultado.ok) {
    await devolverPendenteFila(pendente.id, resultado.motivo);
    await sendText(OPERATOR_PHONE,
      `Não foi possível atualizar o pedido #${pendente.pedido_id}. ` +
      `O pagamento voltou para a fila. Verifique o status no painel.`, true);
    return true;
  }

  await finalizarPendente(pendente.id, 'confirmado');
  await sendText(pendente.cliente_numero,
    pendente.tipo === 'travessia'
      ? 'Pagamento da travessia confirmado! Sua mercadoria seguirá para São Paulo.'
      : 'Pagamento da comissão confirmado! Agora envie a etiqueta de postagem.', true);

  const restantes = await getPendentesPagamento();
  await sendText(OPERATOR_PHONE,
    `Pagamento do pedido #${pendente.pedido_id} confirmado. ` +
    `Restam ${restantes.length} pagamento(s) na fila.`, true);
  return true;
}

// Executa a opção numérica 1-6 do menu principal. Extraído para reuso: além do
// estado idle/menu, também é chamado quando o cliente digita um número estando
// preso num estado de espera "leve" (etiqueta/comprovante) — ver ESTADOS_COM_ESCAPE.
async function executarComandoMenu(phone, cliente, comando) {
  switch (comando) {
    case '1': await iniciarFlow1(phone); return;
    case '2': await iniciarFlow2(phone, cliente); return;
    case '3': await iniciarFlow3(phone, cliente); return;
    case '4': await iniciarFlow4(phone, cliente); return;
    case '5':
      await sendText(phone, 'Por favor, envie a etiqueta de postagem.', true);
      await setConversa(phone, { estado: 'flow4_etiqueta', dados: { cliente_nome: cliente.nome } });
      return;
    case '6':
      await send(phone, 'Informe que vai chamar o operador e peça para aguardar.', {},
        'Vou chamar o operador. Aguarde um momento.');
      await sendText(OPERATOR_PHONE, `📞 Cliente ${phone} quer falar com você.`, true);
      await clearConversa(phone);
      return;
  }
}

// ── roteador principal ────────────────────────────────────────────────────────

async function handleMessage(phone, tipo, body, mediaUrl, mimeType, rawContent = null) {
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

  // Mensalidade VIP vencida — bloqueia qualquer fluxo até regularizar.
  // Tem prioridade sobre tudo, inclusive o comando global "menu".
  if (statusMensalidadeEfetivo(clienteCadastrado) === 'vencida') {
    logger.info(`[menu] Bloqueado por mensalidade vencida: ${normalPhone}`);
    await sendText(normalPhone, 'Cliente não ativo. Mensalidade do VIP pendente.', true);
    return;
  }

  // Timeout — reinicia o fluxo (exceto estados de pagamento/etiqueta que precisam de tempo real)
  const ESTADOS_SEM_TIMEOUT = ['idle', 'menu', 'flow4_comprovante', 'flow4_etiqueta', 'flow4_selecao_pedido'];
  const conv = await getConversa(normalPhone);
  if (conv && !ESTADOS_SEM_TIMEOUT.includes(conv.estado) && isTimedOut(conv)) {
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

  // Estados de espera "leve" não devem travar o cliente se ele quiser começar
  // outra coisa — ex: cliente preso esperando etiqueta de um pedido antigo,
  // mas quer mandar nota de uma compra nova. Comando numérico funciona aqui
  // como comando global, igual já funciona a partir do idle/menu.
  const ESTADOS_COM_ESCAPE = ['flow4_etiqueta', 'flow4_comprovante'];
  if (ESTADOS_COM_ESCAPE.includes(estado) && /^[1-6]$/.test(bodyNorm)) {
    saveUserMsg(normalPhone, bodyNorm);
    await executarComandoMenu(normalPhone, clienteCadastrado, bodyNorm);
    return;
  }

  // Fluxos ativos
  if (estado.startsWith('flow1_'))         { await handleFlow1(normalPhone, estado, bodyNorm, mediaUrl, mimeType, rawContent); return; }
  if (estado === 'flow2_selecao')          { await handleFlow2Selecao(normalPhone, bodyNorm); return; }
  if (estado.startsWith('flow4_'))        { await handleFlow4(normalPhone, estado, bodyNorm, mediaUrl); return; }

  // Estado idle/menu — seleção numérica
  if (/^[1-6]$/.test(bodyNorm)) {
    saveUserMsg(normalPhone, bodyNorm);
    await executarComandoMenu(normalPhone, clienteCadastrado, bodyNorm);
    return;
  }

  // Texto livre — Claude detecta intenção
  saveUserMsg(normalPhone, bodyNorm);
  if (bodyNorm.length > 2) {
    const intencao = await detectarIntencao(bodyNorm);
    if (intencao >= 1 && intencao <= 6) {
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

module.exports = {
  handleMessage,
  showMenu,
  parseComandoFila,
  formatarFila,
};
