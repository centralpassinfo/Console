'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { encryptSecret, decryptSecret, encryptBuffer, decryptBuffer, resolveKey } = require('../src/crypto');

test('AES-256-GCM secrets round-trip without storing plaintext', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const plaintext = 'platform-key-that-is-longer-than-thirty-two-characters';
  const encrypted = encryptSecret(plaintext, key);
  assert.match(encrypted, /^v1:/);
  assert.equal(encrypted.includes(plaintext), false);
  assert.equal(decryptSecret(encrypted, key), plaintext);
});

test('encryption rejects keys that are not 32 bytes', () => {
  assert.throws(() => resolveKey('too-short'), /32 bytes/);
});

test('authenticated encryption rejects tampering', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const encrypted = encryptSecret('sensitive', key);
  const changed = `${encrypted.slice(0, -2)}AA`;
  assert.throws(() => decryptSecret(changed, key));
});

test('contract files round-trip as authenticated binary data', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const source = Buffer.from('%PDF-1.7\nprivate contract contents\n%%EOF');
  const encrypted = encryptBuffer(source, key);
  assert.equal(encrypted.includes(source), false);
  assert.deepEqual(decryptBuffer(encrypted, key), source);
});

test('contract file encryption rejects tampering', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const encrypted = encryptBuffer(Buffer.from('%PDF-1.7\ncontract'), key);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(encrypted, key));
});
