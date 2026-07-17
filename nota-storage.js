'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function safePart(value, fallback = 'nota') {
  const clean = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return clean || fallback;
}

function getBucketName() {
  return process.env.FIREBASE_STORAGE_BUCKET || 'minhaimportacao-5442a.firebasestorage.app';
}

async function salvarNotaRecebida(buffer, { mimeType, phone, loja } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Arquivo da nota vazio');
  }

  const type = MIME_EXT[mimeType] ? mimeType : 'image/jpeg';
  const ext = MIME_EXT[type];
  const baseName = `${safePart(loja)}_${Date.now()}.${ext}`;
  const path = `notas/whatsapp/${safePart(phone, 'cliente')}/${baseName}`;
  const token = crypto.randomUUID();
  const bucketName = getBucketName();
  const file = admin.storage().bucket(bucketName).file(path);

  await file.save(buffer, {
    resumable: false,
    contentType: type,
    metadata: {
      contentType: type,
      metadata: {
        firebaseStorageDownloadTokens: token,
      },
    },
  });

  return {
    url: `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`,
    path,
    name: baseName,
    type,
  };
}

module.exports = {
  getBucketName,
  safePart,
  salvarNotaRecebida,
};
