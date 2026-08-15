'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { contractState, parseMoneyToCents, summarizeContracts } = require('../src/contracts');

const TODAY = new Date('2026-08-15T00:00:00Z');

test('contract state identifies active, expiring and expired signed agreements', () => {
  assert.equal(contractState({ status: 'signed', expiry_date: '2027-01-01' }, TODAY), 'active');
  assert.equal(contractState({ status: 'signed', expiry_date: '2026-09-10' }, TODAY), 'expiring');
  assert.equal(contractState({ status: 'signed', expiry_date: '2026-08-14' }, TODAY), 'expired');
});

test('contract summary prioritises an expiring live agreement', () => {
  assert.deepEqual(summarizeContracts([
    { status: 'expired', expiry_date: '2025-01-01' },
    { status: 'signed', expiry_date: '2026-09-10' },
  ], TODAY), { state: 'expiring', count: 2, nextExpiry: '2026-09-10' });
});

test('money parser stores exact cents and rejects ambiguous input', () => {
  assert.equal(parseMoneyToCents('2500.50'), 250050);
  assert.equal(parseMoneyToCents(''), null);
  assert.throws(() => parseMoneyToCents('12.345'), /two decimal/);
});
