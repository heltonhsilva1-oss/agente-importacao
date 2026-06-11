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

module.exports = {
  onlyDigits,
  normalizePhone,
  getPortalLinkSecret,
  isPortalLinkConfigured,
  signPortalPhone,
  verifyPortalPhone,
  buildPortalLink,
};
