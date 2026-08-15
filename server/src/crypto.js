'use strict';

const crypto = require('crypto');
const { config } = require('./config');

const FILE_MAGIC = Buffer.from('CPF1');
const CONTRACT_FILE_AAD = Buffer.from('centralpass:contract-file:v1');

function resolveKey(raw = config.encryptionKey) {
  if (!raw) throw new Error('ENCRYPTION_KEY is required');
  const value = String(raw).trim();
  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters or base64');
  }
  return key;
}

function encryptSecret(plaintext, rawKey) {
  if (typeof plaintext !== 'string' || !plaintext) throw new Error('Cannot encrypt an empty secret');
  const key = resolveKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(payload, rawKey) {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = String(payload || '').split(':');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error('Encrypted secret has an unsupported format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', resolveKey(rawKey), Buffer.from(ivEncoded, 'base64'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptBuffer(value, rawKey) {
  if (!Buffer.isBuffer(value) || value.length === 0) throw new Error('Cannot encrypt an empty file');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', resolveKey(rawKey), iv);
  cipher.setAAD(CONTRACT_FILE_AAD);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(value, rawKey) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (payload.length < 33 || !payload.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new Error('Encrypted file has an unsupported format');
  }
  const iv = payload.subarray(4, 16);
  const tag = payload.subarray(16, 32);
  const ciphertext = payload.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', resolveKey(rawKey), iv);
  decipher.setAAD(CONTRACT_FILE_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { encryptSecret, decryptSecret, encryptBuffer, decryptBuffer, resolveKey };
