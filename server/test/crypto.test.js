'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { encryptSecret, decryptSecret, resolveKey } = require('../src/crypto');

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

