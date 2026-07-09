'use strict';
// Integração com Claude API — gera respostas naturais em português
// A máquina de estados (menu.js) controla a lógica; Claude controla a linguagem

const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Prompt base do agente — identidade e regras fixas
const SYSTEM_BASE = `Você é o assistente virtual da *Kidex Importações*, empresa que traz produtos do Paraguai para São Paulo.

Personalidade: amigável, prestativo, direto. Sem emojis. Mensagens curtas e objetivas.
Idioma: português brasileiro informal mas profissional.

Regras absolutas:
- Nunca compartilhe dados de outros clientes
- Não invente informações sobre pedidos ou preços
- Se não souber responder, ofereça conectar com o operador (opção 5)
- Mantenha o foco nos fluxos de atendimento da empresa

Fluxos disponíveis:
1️⃣ Enviar nota fiscal
2️⃣ Ver status do meu pedido
3️⃣ Ver o que devo
4️⃣ Avisar que paguei
5️⃣ Enviar etiqueta de postagem
6️⃣ Falar com o operador`;

/**
 * Gera uma resposta natural via Claude.
 *
 * @param {object} ctx  - Contexto da conversa
 *   ctx.estado         - Estado atual (flow1_loja, menu, etc.)
 *   ctx.dados          - Dados coletados no fluxo atual
 *   ctx.clienteNome    - Nome do cliente (se autenticado)
 *   ctx.extra          - Texto extra de contexto (ex: lista de pedidos)
 * @param {string} instrucao - O que Claude deve fazer/dizer agora
 * @param {number} maxTokens - Limite de tokens (padrão 200)
 */
async function responder(ctx, instrucao, maxTokens = 200) {
  const partes = [SYSTEM_BASE];

  if (ctx.estado)      partes.push(`\nEstado atual: ${ctx.estado}`);
  if (ctx.clienteNome) partes.push(`Cliente identificado: ${ctx.clienteNome}`);
  if (ctx.dados && Object.keys(ctx.dados).length) {
    partes.push(`Dados coletados: ${JSON.stringify(ctx.dados)}`);
  }
  if (ctx.extra)       partes.push(`\n${ctx.extra}`);

  // Inclui histórico recente da conversa se disponível
  if (ctx.historico && ctx.historico.length > 0) {
    const hist = ctx.historico
      .slice(-6)
      .map(h => `${h.role === 'user' ? 'Cliente' : 'Agente'}: ${h.content}`)
      .join('\n');
    partes.push(`\nHistórico recente:\n${hist}`);
  }

  const systemPrompt = partes.join('\n');

  // A instrução é um comando interno para Claude — não é o que o cliente enviou.
  // Estrutura clara: sistema define o contexto, usuário pede a ação, Claude escreve a mensagem.
  const mensagemParaClaude =
    `[INSTRUÇÃO INTERNA — não mostrar ao cliente]\n` +
    `Escreva UMA mensagem de WhatsApp para enviar ao cliente agora.\n` +
    `O que você deve comunicar: ${instrucao}\n\n` +
    `Responda APENAS com o texto da mensagem, sem explicações, sem aspas.`;

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: mensagemParaClaude }],
    });
    return (resp.content[0]?.text || '').trim();
  } catch (err) {
    logger.error('[claude] Erro ao gerar resposta:', err.message);
    return null; // caller usa fallback
  }
}

/**
 * Detecta qual fluxo (1-6) o cliente quer a partir de texto livre.
 * Retorna 0 se não identificar.
 */
async function detectarIntencao(texto) {
  if (!texto?.trim()) return 0;
  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 5,
      system:
        'Classifique a intenção. Responda SOMENTE com o número:\n' +
        '1=enviar nota fiscal  2=ver status do pedido  3=ver débitos/valores\n' +
        '4=avisar pagamento realizado  5=enviar etiqueta de postagem\n' +
        '6=falar com operador  0=não identificado',
      messages: [{ role: 'user', content: texto }],
    });
    const n = parseInt((resp.content[0]?.text || '0').trim());
    return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 0;
  } catch {
    return 0;
  }
}

// Detecta o tipo de mídia real pelos primeiros bytes do arquivo (mais confiável que o header HTTP)
function sniffMediaType(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  // WebP: cabeçalho RIFF????WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  return null;
}

/**
 * Extrai produtos de uma nota fiscal (imagem ou PDF) via Claude Vision.
 * Retorna { produtos: [...] } em sucesso, { erro: string } em formato inválido, ou null em erro inesperado.
 */
async function extrairProdutosNota(mediaUrl) {
  try {
    const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ao baixar nota`);

    const buffer    = Buffer.from(await response.arrayBuffer());
    const rawType   = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const sniffed   = sniffMediaType(buffer);
    const hexHeader = buffer.slice(0, 16).toString('hex').match(/../g).join(' ');

    logger.info(`[claude] nota: rawType=${rawType} sniffed=${sniffed} bytes=${buffer.length} header=[${hexHeader}]`);

    // URL expirada / inválida devolve HTML
    if (buffer[0] === 0x3C /* '<' */) {
      logger.warn('[claude] nota: resposta é HTML — URL provavelmente expirada');
      return { erro: 'url_expirada' };
    }

    const ALLOWED_IMG = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const isPdf = sniffed === 'application/pdf'
      || rawType.includes('pdf')
      || mediaUrl.toLowerCase().includes('.pdf');

    // Resolve o tipo de imagem: magic bytes têm prioridade sobre Content-Type
    const imgType = sniffed && ALLOWED_IMG.includes(sniffed) ? sniffed
      : ALLOWED_IMG.includes(rawType)                        ? rawType
      : rawType === 'image/jpg'                              ? 'image/jpeg'
      : null;

    // Formato não suportado pelo Claude (ex: HEIC, BMP, TIFF)
    if (!isPdf && !imgType) {
      logger.warn(`[claude] nota: formato não suportado sniffed=${sniffed} rawType=${rawType}`);
      return { erro: 'formato_nao_suportado', sniffed, rawType };
    }

    const base64        = buffer.toString('base64');
    const contentBlock  = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: imgType,            data: base64 } };

    const createParams = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          {
            type: 'text',
            text:
              'Analise esta nota fiscal e extraia a lista de produtos comprados.\n' +
              'Retorne SOMENTE um JSON válido, sem nenhum texto antes ou depois:\n' +
              '{"produtos":[{"descricao":"nome do produto","quantidade":1,"valor_unitario_usd":0.00}]}\n' +
              'Se não conseguir ler um campo use null. Se não houver produtos retorne {"produtos":[]}.',
          },
        ],
      }],
    };
    if (isPdf) createParams.betas = ['pdfs-2024-09-25'];

    const resp  = await client.messages.create(createParams);
    const text  = (resp.content[0]?.text || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) {
    logger.error('[claude] extrairProdutosNota erro:', err.message);
    return null;
  }
}

module.exports = { responder, detectarIntencao, extrairProdutosNota };
