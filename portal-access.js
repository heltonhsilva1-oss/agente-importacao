'use strict';

const crypto = require('crypto');

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  const digits = onlyDigits(value);
  return digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
}

function getPortalLinkSecret() {
  return String(process.env.PORTAL_LINK_SECRET || '').trim();
}

function isPortalLinkConfigured(secret = getPortalLinkSecret()) {
  return secret.length >= 32;
}

function signPortalPhone(phone, secret = getPortalLinkSecret()) {
  if (!isPortalLinkConfigured(secret)) return '';
  return crypto
    .createHmac('sha256', secret)
    .update(`kidex-portal:v1:${normalizePhone(phone)}`)
    .digest('hex');
}

function verifyPortalPhone(phone, signature, secret = getPortalLinkSecret()) {
  const expected = signPortalPhone(phone, secret);
  if (!expected || !signature) return false;

  const receivedBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function buildPortalLink(baseUrl, phone) {
  const signature = signPortalPhone(phone);
  if (!signature) return String(baseUrl || '');

  const separator = String(baseUrl).includes('?') ? '&' : '?';
  return `${baseUrl}${separator}tel=${onlyDigits(phone)}&acesso=${signature}`;
}

function issuePortalSession(clienteId, secret = getPortalLinkSecret(), now = Date.now()) {
  if (!isPortalLinkConfigured(secret) || clienteId === undefined || clienteId === null) return '';
  const payload = Buffer.from(JSON.stringify({
    clienteId: String(clienteId),
    exp: now + 30 * 60 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyPortalSession(token, secret = getPortalLinkSecret(), now = Date.now()) {
  if (!isPortalLinkConfigured(secret) || !token) return null;
  const [payload, received] = String(token).split('.');
  if (!payload || !received) return null;

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.clienteId || !Number.isFinite(decoded.exp) || decoded.exp <= now) return null;
    return { clienteId: String(decoded.clienteId), exp: decoded.exp };
  } catch {
    return null;
  }
}

module.exports = {
  onlyDigits,
  normalizePhone,
  getPortalLinkSecret,
  isPortalLinkConfigured,
  signPortalPhone,
  verifyPortalPhone,
  buildPortalLink,
  issuePortalSession,
  verifyPortalSession,
};
