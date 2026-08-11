'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeBase32, decodeBase32, totpAt, verifyTotp } = require('../src/totp');

test('base32 round-trips binary values', () => {
  const value = Buffer.from('CentralPass');
  assert.deepEqual(decodeBase32(encodeBase32(value)), value);
});

test('TOTP matches the RFC 6238 SHA-1 test vector', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpAt(secret, 59000, { digits: 8 }), '94287082');
});

test('TOTP accepts the adjacent time window and rejects invalid codes', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = 1700000000000;
  const previous = totpAt(secret, now - 30000);
  assert.equal(verifyTotp(secret, previous, { timeMs: now, window: 1 }), true);
  assert.equal(verifyTotp(secret, 'not-a-code', { timeMs: now }), false);
});

