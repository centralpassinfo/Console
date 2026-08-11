'use strict';

const crypto = require('crypto');
const { config } = require('./config');

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

module.exports = { encryptSecret, decryptSecret, resolveKey };

