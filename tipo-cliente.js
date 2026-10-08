'use strict';
// Classificação de clientes: VIP (participa do grupo "Vip Kidex", paga
// mensalidade) ou FREE (cadastrado, sem grupo e sem mensalidade).

const { getTipoCliente } = require('./tabela-free');

const GRUPO_VIP_NOME = 'Vip Kidex';
const GRUPO_VIP_JID_PADRAO = '120363427841192975@g.us';

function grupoVipJid() {
  return String(process.env.VIP_GROUP_JID || GRUPO_VIP_JID_PADRAO).trim();
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

// Todas as grafias equivalentes de um telefone brasileiro: com/sem 55 e
// com/sem o nono dígito. Retorna [] se não parecer um telefone válido.
function variantesTelefone(telefone) {
  let d = soDigitos(telefone);
  if (!d) return [];
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return [];
  const ddd = d.slice(0, 2);
  let local = d.slice(2);
  const resultado = new Set();
  const comNono = local.length === 9 ? local : (local.length === 8 && /^[6-9]/.test(local) ? `9${local}` : null);
  const semNono = local.length === 8 ? local : (local.length === 9 && local[0] === '9' ? local.slice(1) : null);
  for (const l of [comNono, semNono, local]) {
    if (l) resultado.add(`55${ddd}${l}`);
  }
  return [...resultado];
}

// Chave canônica (sempre com nono dígito quando aplicável) para comparação.
function chaveTelefone(telefone) {
  const v = variantesTelefone(telefone);
  if (!v.length) return null;
  return v.find(x => x.length === 13) || v[0];
}

// Extrai telefones dos participantes devolvidos pela UAZAPI. Entradas só com
// LID (sem número) são contadas em `semTelefone`.
function extrairTelefonesParticipantes(participantes = []) {
  const telefones = new Set();
  let semTelefone = 0;
  for (const p of participantes) {
    const candidatos = typeof p === 'string'
      ? [p]
      : [p?.PhoneNumber, p?.phoneNumber, p?.phone, p?.JID, p?.jid, p?.id, p?.Id];
    let achou = false;
    for (const c of candidatos) {
      if (!c || /@lid$/i.test(String(c))) continue;
      const k = chaveTelefone(String(c).split('@')[0]);
      if (k) { telefones.add(k); achou = true; break; }
    }
    if (!achou) semTelefone += 1;
  }
  return { telefones, semTelefone };
}

// Classifica clientes pelo grupo. Nunca remove nem adiciona ninguém.
// Retorna listas separadas e contagens para a prévia.
function classificarClientes(clientes, telefonesGrupo) {
  const vip = []; const free = []; const naoIdentificados = []; const jaClassificados = [];
  for (const c of clientes) {
    const chave = chaveTelefone(c.telefone);
    if (!chave) {
      naoIdentificados.push({ id: c.id, nome: c.nome || '', motivo: 'sem_telefone_valido' });
      continue;
    }
    const noGrupo = telefonesGrupo.has(chave);
    const alvo = noGrupo ? 'vip' : 'free';
    const atual = getTipoCliente(c);
    const item = { id: c.id, nome: c.nome || '', telefone: chave, tipo_atual: atual, tipo_novo: alvo };
    if (atual === alvo) jaClassificados.push(item);
    else (noGrupo ? vip : free).push(item);
  }
  return { vip, free, naoIdentificados, jaClassificados };
}

// Campos a gravar numa conversão, mais o evento de histórico correspondente.
function montarConversao(cliente, { para, motivo, origem, agora = new Date() }) {
  const de = getTipoCliente(cliente);
  const campos = { tipo_cliente: para, tipo_cliente_atualizado_em: agora };
  if (para === 'vip') campos.status_vip = 'ativo';
  const evento = {
    cliente_doc_id: null, cliente_id: cliente.id ?? null, cliente_nome: cliente.nome || '',
    de, para, motivo, origem, criado_em: agora,
  };
  return { campos, evento };
}

// Grava a conversão e o histórico. `db` é o Firestore admin.
async function aplicarConversao(db, docRef, cliente, opcoes, extras = {}) {
  const { campos, evento } = montarConversao(cliente, opcoes);
  evento.cliente_doc_id = docRef.id;
  await docRef.set({ ...campos, ...extras }, { merge: true });
  await db.collection('historico_tipo_cliente').add(evento);
  return evento;
}

// Pagamento da mensalidade confirmado por quem está fora do grupo (removido por
// inadimplência, saiu ou Free): reinclui no grupo e só então volta a VIP.
// Retorna true se reincluiu; se a reinclusão falhar o cliente continua Free e o
// erro sobe para o chamador avisar o operador.
async function reincluirVipPago({ db, clienteRef, cliente, phone, adicionarAoGrupo, extras = {} }) {
  const deveReincluir = cliente?.status_vip === 'removido_inadimplencia' || getTipoCliente(cliente) === 'free';
  if (!deveReincluir || !phone) return false;
  await adicionarAoGrupo(grupoVipJid(), 'add', [phone]);
  await aplicarConversao(db, clienteRef, cliente, {
    para: 'vip', motivo: 'pagamento_mensalidade_reinclusao', origem: 'mercadopago.mensalidade_vip',
  }, extras);
  return true;
}

module.exports = {
  reincluirVipPago,
  GRUPO_VIP_NOME, GRUPO_VIP_JID_PADRAO, grupoVipJid,
  variantesTelefone, chaveTelefone, extrairTelefonesParticipantes,
  classificarClientes, montarConversao, aplicarConversao, getTipoCliente,
};
