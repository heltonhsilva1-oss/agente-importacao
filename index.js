'use strict';

// ── Inicializa o Firebase Admin antes de qualquer outro require ───────────────
const admin = require('firebase-admin');

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : null;

if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  // Fallback: credenciais padrão da aplicação (útil no Cloud Run / GCP)
  admin.initializeApp();
}

// ── Express ───────────────────────────────────────────────────────────────────
const express = require('express');
const { logger } = require('./logger');
const { setupWebhook } = require('./webhook');
const { setupPortal } = require('./portal');
const { setupMercadoPago } = require('./mercadopago');
const { setupAdminNotas } = require('./admin-notas');
const { setupListeners } = require('./notificacoes');
const { setupAgendamentos } = require('./agendamentos');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Rotas: webhook + health check
setupWebhook(app);
setupPortal(app);
setupMercadoPago(app);
setupAdminNotas(app);

// Listeners Firestore em tempo real (notificações automáticas de status)
setupListeners();

// Cron jobs (lembretes, alertas, fila de mensagens)
setupAgendamentos();

// ── Inicia o servidor ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`[server] Agente WhatsApp rodando na porta ${PORT}`);
  logger.info(`[server] Webhook protegido disponível em POST /webhook/<segredo>`);
});
