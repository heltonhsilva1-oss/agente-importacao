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
  getConfiguracoes, getViagens,
} = require('./firestore');
const { sendText } = require('./uazapi');
const { getCobrancaPendente } = require('./pagamentos');
const { buildPortalLink } = require('./portal-access');
const { statusMensalidadeEfetivo, mensalidadeEmCobranca } = require('./mensalidade');
const { aplicarConversao, getTipoCliente, grupoVipJid } = require('./tipo-cliente');
const { padronizarNomeLoja } = require('./lojas');

const OPERATOR_PHONE = process.env.OPERATOR_PHONE || '5511995715042';
const PORTAL_URL     = process.env.PORTAL_URL     || 'https://minhaimportacao-5442a.web.app/portal';
const TIMEOUT_MS     = 10 * 60 * 1000;
const ESTADOS_SEM_TIMEOUT = new Set(['idle', 'menu', 'flow4_comprovante', 'flow4_selecao_pedido']);

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

function estadoExpiraPorInatividade(estado) {
  return !ESTADOS_SEM_TIMEOUT.has(estado);
}

const STATUS_LABELS = {
  nota_recebida:             'Nota Recebida 📝',
  retirado_paraguai:         'Retirado no Paraguai 🇵🇾',
  aguardando_pgto_travessia: 'Aguardando Pgto. Travessia 💰',
  aguardando_pgto_comissao_antecipada: 'Aguardando 50% da Comissão 💰',
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

// A viagem atual aceita notas enquanto sua data de saída pertence ao ciclo
// aberto pelo dia/horário de corte configurado. A data em que o cadastro da
// viagem foi criado não deve antecipar o fechamento da janela operacional.
function dataReferenciaCicloViagem(viagem) {
  if (viagem?.data_saida) {
    const [y, m, d] = String(viagem.data_saida).split('-').map(Number);
    if (y && m && d) return instanteSaoPaulo(y, m, d, 0, 0);
  }

  // Compatibilidade com documentos legados que não possuem data_saida.
  if (viagem?.criado_em) return new Date(viagem.criado_em);
  return null;
}

function viagemPertenceAoCicloAtual(viagem, ultimoCorte) {
  if (!viagem) return false;
  const dataRef = dataReferenciaCicloViagem(viagem);
  if (!dataRef) return true;
  return !isNaN(dataRef) && dataRef >= ultimoCorte;
}

// O corte operacional de uma viagem é a ocorrência configurada imediatamente
// anterior (ou igual) à data de retorno. Ex.: retorno no sábado e corte na
// sexta → encerra na sexta; retorno na própria sexta → encerra naquele dia.
// Isso evita fechar uma viagem ainda em andamento usando a sexta-feira que
// aconteceu logo depois da saída.
function calcCorteDaViagem(viagem, horarioCorte, diaCorte) {
  if (!viagem?.data_retorno) return null;
  const [y, m, d] = String(viagem.data_retorno).split('-').map(Number);
  if (!y || !m || !d) return null;

  const [hS, mS] = String(horarioCorte || '11:00').split(':');
  const hC = parseInt(hS, 10) || 0;
  const mC = parseInt(mS, 10) || 0;
  const diaAlvo = Number.isInteger(diaCorte) ? diaCorte : 5;

  const retornoUtc = new Date(Date.UTC(y, m - 1, d));
  const diasAtras = (retornoUtc.getUTCDay() - diaAlvo + 7) % 7;
  retornoUtc.setUTCDate(retornoUtc.getUTCDate() - diasAtras);

  return instanteSaoPaulo(
    retornoUtc.getUTCFullYear(),
    retornoUtc.getUTCMonth() + 1,
    retornoUtc.getUTCDate(),
    hC,
    mC,
  );
}

// ── janela de notas da viagem ────────────────────────────────────────────────
// Uma regra só (bot e sistema): a viagem em andamento recebe notas desde que é
// criada (nesse momento os clientes são avisados) até o corte definido pelo
// operador (data + hora, horário de Brasília). Sem corte definido, vale até o
// fim do dia da data de retorno; sem retorno, enquanto estiver em andamento.

function partesData(ymd) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  return y && m && d ? { y, m, d } : null;
}

function partesHora(hhmm, padrao) {
  const [h, mi] = String(hhmm || padrao).split(':');
  return { h: parseInt(h, 10) || 0, mi: parseInt(mi, 10) || 0 };
}

// Instante do corte da viagem (ou null se não houver data de corte).
function corteDaViagem(viagem, cfg = {}) {
  const dc = partesData(viagem?.data_corte);
  if (!dc) return null;
  const h = partesHora(viagem.hora_corte, cfg.horarioCorte || '23:59');
  return instanteSaoPaulo(dc.y, dc.m, dc.d, h.h, h.mi);
}

function viagemAceitaNotas(viagem, cfg, instanteAgora = new Date()) {
  if (!viagem || (viagem.status && viagem.status !== 'em_andamento')) return false;

  const corte = corteDaViagem(viagem, cfg);
  if (corte) return instanteAgora <= corte;

  // Viagem sem data de corte definida: vale a data de retorno que o operador
  // informou (até o fim desse dia, sem regra de "sexta"); sem retorno, aceita
  // enquanto a viagem estiver em andamento.
  const fimDoRetorno = fimDoDiaDeRetorno(viagem);
  return fimDoRetorno ? instanteAgora <= fimDoRetorno : true;
}

function fimDoDiaDeRetorno(viagem) {
  const dr = partesData(viagem?.data_retorno);
  if (!dr) return null;
  return new Date(instanteSaoPaulo(dr.y, dr.m, dr.d, 23, 59).getTime() + 59 * 1000);
}

function formatarDataHora(instante) {
  const p = componentesSaoPaulo(instante);
  const dois = n => String(n).padStart(2, '0');
  return `${dois(p.day)}/${dois(p.month)} às ${dois(p.hour)}:${dois(p.minute)}`;
}

// Escolhe a viagem que recebe notas: entre as "em andamento", a que ainda está
// dentro do corte (a de maior número se houver mais de uma); se nenhuma está, a
// de maior número, só para explicar ao cliente por que não aceita.
function escolherViagemParaNotas(viagens, cfg, instanteAgora = new Date()) {
  const abertas = (viagens || [])
    .filter(v => !v.status || v.status === 'em_andamento')
    .sort((a, b) => Number(b.id) - Number(a.id));
  return abertas.find(v => viagemAceitaNotas(v, cfg, instanteAgora)) || abertas[0] || null;
}

// { aceita, mensagem } — a mensagem diz ao cliente exatamente o motivo.
function avaliarJanelaNotas(viagens, cfg, instanteAgora = new Date()) {
  const viagem = escolherViagemParaNotas(viagens, cfg, instanteAgora);
  if (viagem && viagemAceitaNotas(viagem, cfg, instanteAgora)) return { aceita: true, viagem, mensagem: '' };

  if (!viagem) {
    return {
      aceita: false, viagem: null,
      mensagem: 'No momento não há viagem aberta para receber notas. Assim que a próxima abrir, avisamos por aqui.',
    };
  }
  const corte = corteDaViagem(viagem, cfg);
  if (corte) {
    return {
      aceita: false, viagem,
      mensagem: `O corte desta viagem foi em ${formatarDataHora(corte)}, então não estamos mais recebendo notas. ` +
        'Aguarde a próxima viagem abrir e envie sua nota assim que avisarmos por aqui.',
    };
  }
  const fim = fimDoDiaDeRetorno(viagem);
  const dr = partesData(viagem.data_retorno);
  return {
    aceita: false, viagem,
    mensagem: fim && dr
      ? `Esta viagem terminou em ${String(dr.d).padStart(2, '0')}/${String(dr.m).padStart(2, '0')}, então não estamos mais recebendo notas. ` +
        'Aguarde a próxima viagem abrir e envie sua nota assim que avisarmos por aqui.'
      : MSG_FORA_DO_CORTE,
  };
}

async function janelaDeNotasAgora() {
  const [cfg, viagens] = await Promise.all([getConfiguracoes(), getViagens()]);
  return avaliarJanelaNotas(viagens, cfg);
}

// Mensagem que é só um cumprimento ("oi", "bom dia", "olá, tudo bem?").
const PALAVRAS_SAUDACAO = new Set([
  'oi', 'oii', 'oiii', 'oie', 'ola', 'opa', 'eai', 'e', 'ai', 'bom', 'dia', 'boa', 'tarde', 'noite',
  'tudo', 'bem', 'td', 'certo', 'bom', 'salve', 'hey', 'hello', 'hi', 'pessoal', 'gente', 'como',
  'vai', 'voce', 'vc', 'ola', 'oláa',
]);
function ehSaudacao(texto) {
  const palavras = String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(p => p.replace(/(.)\1{2,}/g, '$1$1')); // "oiiiii" -> "oii"
  return palavras.length > 0 && palavras.length <= 6 && palavras.every(p => PALAVRAS_SAUDACAO.has(p));
}

const MSG_FORA_DO_CORTE =
  'No momento não estamos mais aceitando notas fiscais — o corte desta semana já passou. ' +
  'Aguarde a próxima viagem abrir e envie sua nota assim que avisarmos por aqui.';

async function iniciarFlow1(phone) {
  const janela = await janelaDeNotasAgora();
  if (!janela.aceita) {
    await sendText(phone, janela.mensagem, true);
    return;
  }

  // Basta a foto: loja e produtos são lidos da própria nota.
  await sendText(phone,
    'Pode enviar a foto, print ou PDF da nota fiscal. 📄\n\n' +
    'Se tiver mais de uma nota, envie uma de cada vez. Quando terminar, responda *PRONTO*.',
    true);
  await setConversa(phone, { estado: 'flow1_notas', dados: dadosVaziosNotas() });
}

// ══ Envio de notas pelo WhatsApp ═════════════════════════════════════════════
// O cliente manda a(s) foto(s). Cada foto vira uma nota numerada e é lida em
// paralelo. Loja e vendedor vêm da leitura; só o que a leitura não achar é
// perguntado ao cliente, uma nota por vez. Estado único: flow1_notas, com
//   dados = { count, pendentes: [{ n, mediaUrl, mimeType, rawContent, loja, vendedor, fase }],
//             resumo: [{ n, loja, vendedor }], perguntando: n|null, finalizar: bool }
// fase: 'lendo' | 'aguardando_info'. Notas já registradas saem de `pendentes`.

const ATRASO_CONFIRMACAO_MS = Number(process.env.NOTAS_CONFIRMACAO_MS ?? 3000);

function dadosVaziosNotas() {
  return { count: 0, pendentes: [], resumo: [], perguntando: null, finalizar: false };
}
const normalizarDadosNotas = dados => ({ ...dadosVaziosNotas(), ...(dados || {}) });

// Aviso ao cliente só quando a leitura dá problema (sucesso é silencioso).
function mensagemFalhaLeitura({ numeroNota, extracaoStatus, erroTipo }) {
  if (erroTipo === 'formato_nao_suportado') {
    return `Não consegui abrir a nota ${numeroNota}. Por favor, reenvie em formato JPG, PNG ou PDF.`;
  }
  if (erroTipo === 'url_expirada') {
    return `A nota ${numeroNota} expirou antes de eu conseguir ler. Por favor, reenvie a foto.`;
  }
  if (extracaoStatus !== 'ok') {
    return `Recebi a nota ${numeroNota}, mas não consegui ler os produtos com clareza. ` +
      'Nossa equipe vai conferir manualmente. Se a foto estiver cortada ou escura, pode reenviar. 🙏';
  }
  return '';
}

// Interpreta "ATN - João", "ATN, João", "ATN / João" ou duas linhas.
// Só a loja também é aceita; o vendedor fica em branco.
function interpretarLojaVendedor(texto) {
  const partes = String(texto || '')
    .split(/\s*(?:\n|,|;|\/|\||\s[-–—]\s)\s*/)
    .map(p => p.trim())
    .filter(Boolean);
  return { loja: partes[0] || '', vendedor: partes.slice(1).join(' ') };
}

// Resultado da leitura de cada nota, em memória (tem o arquivo); se o servidor
// reiniciar, a nota é lida de novo a partir do link.
const leituras = new Map();
const chaveLeitura = (phone, n) => `${phone}:${n}`;

// Cria o rascunho para o operador conferir. Nunca lança: roda "solto".
async function processarNota(phone, nota, numeroNota) {
  try {
    const resultado = await (nota.leitura || extrairProdutosNota(nota.mediaUrl, nota.mimeType, nota.rawContent));
    // resultado: { produtos } | { erro: 'url_expirada'|'formato_nao_suportado'|... } | null
    const erroTipo       = resultado?.erro ?? null;
    const produtos       = resultado?.produtos ?? [];
    const extracaoStatus = !resultado || erroTipo ? 'erro' : produtos.length === 0 ? 'parcial' : 'ok';

    const configuracoes = await getConfiguracoes();
    const loja = padronizarNomeLoja(nota.loja, configuracoes.lojasPadronizadas);
    const vendedor = String(nota.vendedor || '').trim();

    // Resolve cliente pelo número WhatsApp (trata nono dígito e prefixo 55)
    const clienteMatch = await findClienteByWhatsapp(phone);

    let fotoNota = null;
    if (resultado?.arquivo?.buffer) {
      try {
        fotoNota = await salvarNotaRecebida(resultado.arquivo.buffer, {
          mimeType: resultado.arquivo.mimeType, phone, loja,
        });
      } catch (storageErr) {
        logger.error('[menu] não foi possível arquivar nota:', storageErr.message);
      }
    }

    const rascunhoId = await criarRascunhoPedido({
      cliente_phone:      phone,
      cliente_id:         clienteMatch?.id ?? null,
      cliente_nome:       clienteMatch?.nome ?? phone,
      nome_loja:          loja,
      nome_vendedor:      vendedor,
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

    const aviso = mensagemFalhaLeitura({ numeroNota, extracaoStatus, erroTipo });
    if (aviso) await sendText(phone, aviso, true);
    await sendText(OPERATOR_PHONE,
      `Nova nota fiscal recebida! (nota ${numeroNota})\nCliente: ${phone}\nLoja: ${loja || '(não informada — preencha ao validar)'}\nVendedor: ${vendedor || '—'}\nResultado: ${prodMsg}\nID rascunho: ${rascunhoId}`,
      true);
  } catch (err) {
    logger.error('[menu] processarNota erro:', err.message);
  }
}

// Tudo que altera a conversa de notas de um cliente passa por esta fila (uma
// operação por vez), para fotos e respostas simultâneas não se atropelarem.
const filasNotas = new Map();
function emFila(phone, tarefa) {
  const anterior = filasNotas.get(phone) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(tarefa);
  filasNotas.set(phone, atual);
  atual.finally(() => { if (filasNotas.get(phone) === atual) filasNotas.delete(phone); }).catch(() => {});
  return atual;
}

// ── confirmação de recebimento, agrupada (3 fotos seguidas = 1 mensagem) ─────
const confirmacoes = new Map();

function agendarConfirmacao(phone, ehPrimeiraDoAtendimento) {
  const atual = confirmacoes.get(phone) || { quantidade: 0, primeira: ehPrimeiraDoAtendimento, timer: null };
  atual.quantidade += 1;
  clearTimeout(atual.timer);
  atual.timer = setTimeout(() => { descarregarConfirmacao(phone); }, ATRASO_CONFIRMACAO_MS);
  atual.timer.unref?.();
  confirmacoes.set(phone, atual);
}

// Envia já a confirmação pendente (usado quando a leitura termina antes do prazo).
async function descarregarConfirmacao(phone) {
  const c = confirmacoes.get(phone);
  if (!c) return;
  confirmacoes.delete(phone);
  clearTimeout(c.timer);
  const texto = c.quantidade > 1
    ? `Recebi ${c.quantidade} notas ✅ Já estou lendo.`
    : c.primeira ? 'Recebi sua nota ✅ Já estou lendo.' : 'Recebi mais uma nota ✅ Já estou lendo.';
  try {
    await sendText(phone, texto, true);
    appendHistorico(phone, 'assistant', texto);
  } catch (err) {
    logger.error('[menu] falha ao confirmar recebimento da nota:', err.message);
  }
}

// ── perguntas e resumos ──────────────────────────────────────────────────────

function perguntaFaltante(nota, numerar) {
  const frase = txt => (numerar ? `Nota ${nota.n}: ${txt}` : txt[0].toUpperCase() + txt.slice(1));
  if (!nota.loja && !nota.vendedor) {
    return `${frase('não consegui ler a *loja* e o *vendedor*. 😅')}\nPode me dizer numa mensagem só? Por exemplo: *ATN - João*`;
  }
  if (!nota.loja) return frase(`li o vendedor (*${nota.vendedor}*), mas não consegui ler a *loja*. Qual é o nome da loja?`);
  return frase(`li a loja *${nota.loja}*, mas não consegui ler o *vendedor*. Qual é o nome do vendedor?`);
}

const linhaNota = r => `Nota ${r.n}: *${r.loja}*${r.vendedor ? ` · ${r.vendedor}` : ''}`;
const MSG_MAIS_NOTAS = 'Tem mais notas? Envie a foto. Quando terminar, responda *PRONTO*.';

function mensagemFinal(count) {
  return `Perfeito! Recebemos ${count} nota${count !== 1 ? 's' : ''} nesta retirada. Já estamos processando tudo. Obrigado!`;
}

// Decide o que dizer agora (resumo, próxima pergunta, fechamento) e grava a
// conversa. Só fala quando termina a leitura de TODAS as fotos do momento.
async function avancar(phone, dados) {
  if (dados.pendentes.some(p => p.fase === 'lendo')) {
    await setConversa(phone, { estado: 'flow1_notas', dados });
    return;
  }

  const haPergunta = dados.perguntando != null || dados.pendentes.some(p => p.fase === 'aguardando_info');

  if (dados.resumo.length) {
    const k = dados.resumo.length;
    let texto = k === 1
      ? `Anotei ✅ ${linhaNota(dados.resumo[0])}. Já enviei para conferência.`
      : `Anotei ✅ ${k} notas já enviadas para conferência:\n${dados.resumo.map(r => `• ${linhaNota(r)}`).join('\n')}`;
    dados.resumo = [];
    if (!haPergunta && !dados.finalizar) texto += `\n\n${MSG_MAIS_NOTAS}`;
    await sendText(phone, texto, true);
    appendHistorico(phone, 'assistant', texto);
  }

  if (dados.perguntando == null) {
    const proxima = dados.pendentes.find(p => p.fase === 'aguardando_info');
    if (proxima) {
      dados.perguntando = proxima.n;
      const pergunta = perguntaFaltante(proxima, dados.count > 1);
      await sendText(phone, pergunta, true);
      appendHistorico(phone, 'assistant', pergunta);
    }
  }

  if (!dados.pendentes.length && dados.finalizar) {
    await clearConversa(phone);
    await sendText(phone, mensagemFinal(dados.count), true);
    appendHistorico(phone, 'assistant', `Retirada finalizada com ${dados.count} nota(s).`);
    return;
  }
  await setConversa(phone, { estado: 'flow1_notas', dados });
}

// ── recebimento da foto e leitura ────────────────────────────────────────────

// Resultado da leitura chega aqui (dentro da fila): registra a nota se achou
// tudo, ou a deixa aguardando a resposta do cliente.
async function aplicarLeitura(phone, n, leitura) {
  await descarregarConfirmacao(phone);
  const conv = await getConversa(phone);
  if (!conv?.estado?.startsWith('flow1_')) return; // conversa encerrada/expirada: já foi tratada
  const dados = normalizarDadosNotas(conv.dados);
  const nota = dados.pendentes.find(p => p.n === n);
  if (!nota) return;

  const configuracoes = await getConfiguracoes();
  nota.loja = padronizarNomeLoja(leitura?.loja || '', configuracoes.lojasPadronizadas);
  nota.vendedor = String(leitura?.vendedor || '').trim();
  leituras.set(chaveLeitura(phone, n), leitura);

  if (nota.loja && nota.vendedor) {
    processarNota(phone, { ...nota, leitura }, n); // não bloqueia
    leituras.delete(chaveLeitura(phone, n));
    dados.pendentes = dados.pendentes.filter(p => p.n !== n);
    dados.resumo.push({ n, loja: nota.loja, vendedor: nota.vendedor });
  } else {
    nota.fase = 'aguardando_info';
  }
  await avancar(phone, dados);
}

function lerNota(phone, n, { mediaUrl, mimeType, rawContent }) {
  Promise.resolve()
    .then(() => extrairProdutosNota(mediaUrl, mimeType, rawContent))
    .catch(err => { logger.error('[menu] leitura da nota falhou:', err.message); return null; })
    .then(leitura => emFila(phone, () => aplicarLeitura(phone, n, leitura)))
    .catch(err => logger.error('[menu] aplicarLeitura erro:', err.message));
}

// Toda foto vira uma nota: numera, confirma (agrupado) e lê em paralelo.
function receberNotaPorFoto(phone, { mediaUrl, mimeType, rawContent }) {
  return emFila(phone, async () => {
    const janela = await janelaDeNotasAgora();
    if (!janela.aceita) {
      await clearConversa(phone);
      await sendText(phone, janela.mensagem, true);
      return;
    }
    const conv = await getConversa(phone);
    const dados = normalizarDadosNotas(conv?.estado?.startsWith('flow1_') ? conv.dados : null);
    const n = dados.count + 1;
    dados.count = n;
    dados.finalizar = false; // mandou outra nota: o atendimento continua
    dados.pendentes.push({ n, mediaUrl, mimeType, rawContent, loja: '', vendedor: '', fase: 'lendo' });
    await setConversa(phone, { estado: 'flow1_notas', dados });

    agendarConfirmacao(phone, n === 1);
    lerNota(phone, n, { mediaUrl, mimeType, rawContent });
  });
}

// ── texto do cliente durante o envio de notas ────────────────────────────────

const RE_FIM_DAS_NOTAS = /^(pronto|prontinho|n[aã]o|nao|n|finalizar|acabou|encerrar|fim|so isso|s[oó] isso|terminei|0)\b/;

async function tratarTextoNotas(phone, body) {
  const conv = await getConversa(phone);
  if (!conv?.estado?.startsWith('flow1_')) return;
  const dados = normalizarDadosNotas(conv.dados);
  const resposta = String(body || '').trim().toLowerCase();
  const terminou = RE_FIM_DAS_NOTAS.test(resposta);

  // Respondendo a pergunta sobre uma nota (loja e/ou vendedor).
  if (dados.perguntando != null) {
    const nota = dados.pendentes.find(p => p.n === dados.perguntando);
    if (!nota) { dados.perguntando = null; await avancar(phone, dados); return; }

    const pergunta = perguntaFaltante(nota, dados.count > 1);
    let loja = nota.loja;
    let vendedor = nota.vendedor;
    if (terminou && resposta.length <= 8) {
      await sendText(phone, `Antes de finalizar, falta só isso:\n${pergunta}`, true);
      return;
    }
    if (!nota.loja && !nota.vendedor) ({ loja, vendedor } = interpretarLojaVendedor(body));
    else if (!nota.loja) loja = interpretarLojaVendedor(body).loja;
    else vendedor = String(body || '').trim();
    if ((!nota.loja && loja.length < 2) || (nota.loja && vendedor.length < 2)) {
      await sendText(phone, `Não entendi. ${pergunta}`, true);
      return;
    }

    const configuracoes = await getConfiguracoes();
    const lojaFinal = padronizarNomeLoja(loja, configuracoes.lojasPadronizadas);
    const chave = chaveLeitura(phone, nota.n);
    processarNota(phone, { ...nota, loja: lojaFinal, vendedor, leitura: leituras.get(chave) }, nota.n);
    leituras.delete(chave);
    dados.pendentes = dados.pendentes.filter(p => p.n !== nota.n);
    dados.resumo.push({ n: nota.n, loja: lojaFinal, vendedor });
    dados.perguntando = null;
    await avancar(phone, dados);
    return;
  }

  if (terminou) {
    if (dados.pendentes.length) { // ainda lendo
      dados.finalizar = true;
      await setConversa(phone, { estado: 'flow1_notas', dados });
      await sendText(phone, 'Certo! Assim que eu terminar de ler as notas, fecho por aqui. 😊', true);
      return;
    }
    await clearConversa(phone);
    await sendText(phone, dados.count > 0
      ? mensagemFinal(dados.count)
      : 'Tudo bem! Quando quiser enviar uma nota, é só mandar a foto por aqui.', true);
    if (dados.count > 0) appendHistorico(phone, 'assistant', `Retirada finalizada com ${dados.count} nota(s).`);
    return;
  }

  if (dados.pendentes.length) {
    await sendText(phone, 'Só um instante, ainda estou lendo as notas. 😊', true);
    return;
  }
  if (/^(sim|s|outra|mais|tem|quero|1)\b/.test(resposta)) {
    await sendText(phone, 'Certo! Pode enviar a próxima nota (foto, print ou PDF).', true);
    return;
  }
  await sendText(phone,
    dados.count > 0
      ? 'Se tiver mais notas, é só enviar a foto. Quando terminar, responda *PRONTO*.'
      : 'Por favor, envie a foto, print ou PDF da nota fiscal. 📄',
    true);
}

async function handleFlow1(phone, estado, body, mediaUrl, mimeType, rawContent = null) {
  saveUserMsg(phone, body);

  // Qualquer foto/PDF recebido durante o envio de notas é uma nota.
  if (mediaUrl) {
    await receberNotaPorFoto(phone, { mediaUrl, mimeType, rawContent });
    return;
  }
  await emFila(phone, () => tratarTextoNotas(phone, body));
}

// Conversa de notas parada (cliente sumiu): nenhuma nota pode se perder. As
// que ainda estavam pendentes vão para conferência com o que se sabe.
async function registrarPendentesExpirados(phone, conv) {
  const dados = normalizarDadosNotas(conv.dados);
  if (!dados.pendentes.length) return;
  for (const nota of dados.pendentes) {
    const chave = chaveLeitura(phone, nota.n);
    processarNota(phone, { ...nota, leitura: leituras.get(chave) }, nota.n);
    leituras.delete(chave);
  }
  await sendText(phone,
    `Registrei ${dados.pendentes.length === 1 ? 'a nota' : 'as notas'} que faltavam. Alguns dados (loja/vendedor) ficaram em aberto, então nossa equipe vai conferir.`,
    true);
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
    if (p.status === 'aguardando_pgto_comissao_antecipada') {
      const cobranca = getCobrancaPendente(p);
      linha += ` | 50% da comissão: ${fmtCur(cobranca?.valor)}`;
      total += Number(cobranca?.valor) || 0;
    }
    if (p.status === 'aguardando_pgto_comissao' && com > 0) {
      const cobranca = getCobrancaPendente(p);
      linha += ` | Comissão: ${fmtCur(cobranca?.valor)}`;
      total += Number(cobranca?.valor) || 0;
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
    const tipoLabel = cobranca?.tipo === 'travessia'
      ? 'Taxa de travessia'
      : cobranca?.tipo === 'comissao_antecipada' ? '50% da comissão' : 'Comissão';
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

// Mantido para compatibilidade com conversas antigas ainda persistidas.
// eslint-disable-next-line no-unused-vars
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
      const { getFirestore } = require('firebase-admin/firestore');
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
    `   ${p.tipo === 'travessia' ? 'Travessia' : p.tipo === 'comissao_antecipada' ? '50% da comissão' : 'Comissão'}: ${fmtCur(p.valor)}`
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
  // Backup sob demanda (o automático roda às 3h30): confirma que está funcionando.
  if (normalizadoCmd === 'BACKUP') {
    try {
      const { rodarBackupDiario } = require('./backup');
      const r = await rodarBackupDiario();
      await sendText(OPERATOR_PHONE, `Backup de ${r.data} concluído: ${r.total} registros em ${Object.keys(r.colecoes).length} coleções.`, true);
    } catch (erro) {
      await sendText(OPERATOR_PHONE, `Backup falhou: ${String(erro?.message || erro).slice(0, 200)}`, true);
    }
    return true;
  }
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
      } catch {
        // O broadcast continua para os demais clientes.
      }
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
      ? resultado.novoStatus === 'aguardando_pgto_comissao_antecipada'
        ? 'Pagamento da travessia confirmado! Nesta viagem há uma etapa de 50% da comissão disponível no portal.'
        : 'Pagamento da travessia confirmado! Sua mercadoria seguirá para São Paulo.'
      : pendente.tipo === 'comissao_antecipada'
        ? 'Pagamento de 50% da comissão confirmado! Sua mercadoria seguirá para São Paulo.'
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
  const respostaVip = String(body || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Free não paga mensalidade (statusMensalidadeEfetivo devolve 'isento'). Quem
  // foi removido do VIP por inadimplência e responde exatamente PAGAR recebe a
  // cobrança para voltar ao grupo; qualquer outra mensagem segue o fluxo normal.
  const retornoVipRemovido = getTipoCliente(clienteCadastrado) === 'free'
    && clienteCadastrado.status_vip === 'removido_inadimplencia'
    && respostaVip === 'PAGAR';
  if (mensalidadeEmCobranca(clienteCadastrado) || retornoVipRemovido) {
    logger.info(`[menu] Bloqueado por mensalidade vencida: ${normalPhone}`);
    if (respostaVip === 'PAGAR' || respostaVip === '1') {
      const config = await getConfiguracoes();
      const valor = Number(config.valorMensalidadeVIP || 0);
      try {
        const { getFirestore } = require('firebase-admin/firestore');
        const { createVipPixCharge } = require('./mercadopago');
        const db = getFirestore();
        const clienteSnap = await db.collection('clientes').where('id', '==', Number(clienteCadastrado.id)).limit(1).get();
        if (clienteSnap.empty) throw new Error('vip_client_not_found');
        const charge = await createVipPixCharge({ clienteDocId: clienteSnap.docs[0].id, cliente: clienteSnap.docs[0].data(), valor });
        const linhas = [
          `Certo! Sua mensalidade VIP é de *${fmtCur(valor)}*.`,
          charge.qrCode ? `*Pix Copia e Cola:*\n${charge.qrCode}` : null,
          charge.ticketUrl ? `*Abrir pagamento:* ${charge.ticketUrl}` : null,
          'A confirmação será automática após o pagamento.',
        ].filter(Boolean);
        await sendText(normalPhone, linhas.join('\n\n'), true);
        await sendText(OPERATOR_PHONE,
          `💳 ${clienteCadastrado.nome} (${normalPhone}) escolheu *PAGAR* e recebeu a cobrança automática da mensalidade VIP.`, true);
      } catch (error) {
        logger.error('[menu] Falha ao gerar mensalidade VIP:', error.message);
        await sendText(normalPhone, 'Não consegui gerar a cobrança agora. O responsável já foi avisado e vai ajudar você.', true);
        await sendText(OPERATOR_PHONE, `Falha ao gerar cobrança VIP para ${clienteCadastrado.nome} (${normalPhone}): ${error.message}`, true);
      }
      return;
    }
    if (respostaVip === 'SAIR' || respostaVip === '2') {
      const { getFirestore, FieldValue } = require('firebase-admin/firestore');
      const db = getFirestore();
      const clienteSnap = await db.collection('clientes').where('id', '==', Number(clienteCadastrado.id)).limit(1).get();
      if (!clienteSnap.empty) {
        await clienteSnap.docs[0].ref.update({
          solicitou_saida_vip: true,
          solicitou_saida_vip_em: FieldValue.serverTimestamp(),
        });
      }
      try {
        const { updateGroupParticipants } = require('./uazapi');
        await updateGroupParticipants(grupoVipJid(), 'remove', [normalPhone]);
        // Saiu do grupo: não é mais VIP, passa à tabela Free sem mensalidade.
        if (!clienteSnap.empty) {
          await aplicarConversao(db, clienteSnap.docs[0].ref, clienteSnap.docs[0].data(), {
            para: 'free', motivo: 'saida_voluntaria', origem: 'menu.SAIR',
          }, { status_vip: 'saiu_grupo' });
        }
        await sendText(normalPhone, 'Sua saída do Grupo VIP foi concluída.', true);
        await sendText(OPERATOR_PHONE, `🚪 ${clienteCadastrado.nome} (${normalPhone}) solicitou *SAIR DO GRUPO VIP* e foi removido automaticamente.`, true);
      } catch (error) {
        logger.error('[menu] Falha ao remover do VIP:', error.message);
        await sendText(normalPhone, 'Recebi sua solicitação de saída. O responsável foi avisado para concluir a remoção.', true);
        await sendText(OPERATOR_PHONE, `🚪 ${clienteCadastrado.nome} solicitou SAIR, mas a remoção automática falhou: ${error.message}`, true);
      }
      return;
    }
    await sendText(normalPhone,
      'Sua mensalidade VIP está vencida.\n\nResponda:\n*1 ou PAGAR* — receber os dados de pagamento\n*2 ou SAIR* — solicitar a saída do grupo VIP', true);
    return;
  }

  // Timeout — reinicia fluxos ativos; uma espera antiga por etiqueta não pode
  // capturar como etiqueta a nota fiscal enviada dias depois.
  const conv = await getConversa(normalPhone);
  if (conv && estadoExpiraPorInatividade(conv.estado) && isTimedOut(conv)) {
    // Cliente mandou fotos e sumiu antes de responder: a nota não pode se perder.
    if (conv.estado === 'flow1_notas') await registrarPendentesExpirados(normalPhone, conv);
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

  // Mandou a foto da nota direto (sem escolher opção): registra como nota. Se o
  // cliente está esperando para enviar etiqueta, mantém o comportamento antigo
  // para não confundir etiqueta com nota.
  if (mediaUrl && ['image', 'document'].includes(String(tipo || '').toLowerCase()) && ['idle', 'menu'].includes(estado)) {
    const pedidosAtivos = await getPedidosAtivos(clienteCadastrado.id);
    if (!pedidosAtivos.some(p => p.status === 'aguardando_etiqueta')) {
      saveUserMsg(normalPhone, bodyNorm || '[nota enviada]');
      await receberNotaPorFoto(normalPhone, { mediaUrl, mimeType, rawContent });
      return;
    }
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

  // Cumprimento de cliente cadastrado ("oi", "bom dia"): vai direto ao ponto,
  // sem o menu. (Quem está com etiqueta pendente continua vendo o menu.)
  if (!mediaUrl && ['idle', 'menu'].includes(estado) && ehSaudacao(bodyNorm)) {
    const pedidosAtivos = await getPedidosAtivos(clienteCadastrado.id);
    if (!pedidosAtivos.some(p => p.status === 'aguardando_etiqueta')) {
      saveUserMsg(normalPhone, bodyNorm);
      const primeiroNome = String(clienteCadastrado.nome || '').trim().split(/\s+/)[0];
      const ola = primeiroNome ? `Olá, ${primeiroNome}! 👋` : 'Olá! 👋';
      const janela = await janelaDeNotasAgora();
      const corpo = janela.aceita
        ? 'Pode enviar sua nota fiscal por aqui (foto, print ou PDF).'
        : janela.mensagem;
      const texto = `${ola} ${corpo}\n\nPara outras opções, digite *menu*.`;
      await sendText(normalPhone, texto, true);
      appendHistorico(normalPhone, 'assistant', texto);
      return;
    }
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
  calcCorteDaViagem,
  calcUltimoCorte,
  dataReferenciaCicloViagem,
  viagemAceitaNotas,
  corteDaViagem,
  avaliarJanelaNotas,
  escolherViagemParaNotas,
  viagemPertenceAoCicloAtual,
  estadoExpiraPorInatividade,
};
