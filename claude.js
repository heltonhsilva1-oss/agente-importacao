'use strict';
// Integração com Claude API — gera respostas naturais em português
// A máquina de estados (menu.js) controla a lógica; Claude controla a linguagem

const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Prompt base do agente — identidade e regras fixas
const SYSTEM_BASE = `Você é o assistente virtual da *Minha Importação*, empresa que traz produtos do Paraguai para São Paulo.

Personalidade: amigável, prestativo, direto. Use emojis com moderação. Mensagens curtas, no estilo WhatsApp.
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
5️⃣ Falar com o operador`;

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

  const systemPrompt = partes.join('\n');

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: instrucao }],
    });
    return (resp.content[0]?.text || '').trim();
  } catch (err) {
    logger.error('[claude] Erro ao gerar resposta:', err.message);
    return null; // caller usa fallback
  }
}

/**
 * Detecta qual fluxo (1-5) o cliente quer a partir de texto livre.
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
        '4=avisar pagamento realizado  5=falar com operador  0=não identificado',
      messages: [{ role: 'user', content: texto }],
    });
    const n = parseInt((resp.content[0]?.text || '0').trim());
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
  } catch {
    return 0;
  }
}

module.exports = { responder, detectarIntencao };
