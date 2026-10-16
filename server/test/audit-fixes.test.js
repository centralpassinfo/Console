'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateTotpSecret, matchTotpStep, totpAt, verifyTotp } = require('../src/totp');
const { dateOnly } = require('../src/contracts');
const { localDate } = require('../src/timezone');
const { invoiceState } = require('../src/billing');
const { waitForDeployment } = require('../src/release-deployer');

const okJson = (data) => ({ ok: true, json: async () => data });

test('a TOTP code reports the 30-second step it belongs to, so it can be used once', () => {
  const secret = generateTotpSecret();
  const now = Date.UTC(2026, 9, 16, 10, 0, 15);
  const step = Math.floor(now / 30000);
  assert.equal(matchTotpStep(secret, totpAt(secret, now), { timeMs: now }), step);
  assert.equal(matchTotpStep(secret, totpAt(secret, now - 30000), { timeMs: now }), step - 1);
  assert.equal(matchTotpStep(secret, totpAt(secret, now + 30000), { timeMs: now }), step + 1);
  assert.equal(matchTotpStep(secret, totpAt(secret, now - 90000), { timeMs: now }), null);
  assert.equal(matchTotpStep(secret, 'abcdef', { timeMs: now }), null);
  assert.equal(verifyTotp(secret, totpAt(secret, now), { timeMs: now }), true);
});

test('"today" is the Adelaide calendar day, not the UTC one', () => {
  // 8:00 on 17 October in Adelaide is still 16 October in UTC.
  const morning = new Date('2026-10-16T21:30:00Z');
  assert.equal(localDate(morning), '2026-10-17');
  assert.equal(dateOnly(morning), '2026-10-17');
  // DATE columns arrive as text and are never shifted.
  assert.equal(dateOnly('2026-09-15'), '2026-09-15');
  const invoice = { status: 'sent', amount_cents: 100, gst_cents: 0, due_on: '2026-10-16' };
  assert.equal(invoiceState(invoice, [], morning), 'overdue', 'Overdue from the first Adelaide minute after the due date.');
});

test('Railway SLEEPING counts as deployed and NEEDS_APPROVAL fails fast with a next step', async () => {
  const uuid = '12345678-1234-1234-1234-123456789012';
  const reply = (status) => async () => okJson({ data: { deployment: { id: uuid, status } } });
  await waitForDeployment(uuid, 'token', async () => {}, { fetcher: reply('SLEEPING'), sleep: async () => {} });
  let waited = 0;
  await assert.rejects(
    waitForDeployment(uuid, 'token', async () => {}, { fetcher: reply('NEEDS_APPROVAL'), sleep: async () => { waited += 1; } }),
    /approval in Railway/,
  );
  assert.equal(waited, 0, 'No waiting out the timeout for a deployment Railway is holding.');
});

test('release labels never show the raw commit-<sha> name', async () => {
  const { releaseLabel, progressSteps } = await import('../../src/releaseLabel.mjs');
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  assert.equal(releaseLabel({ version: `commit-${sha}`, commit_sha: sha }), 'Update abcdef01');
  assert.equal(releaseLabel({ version: `commit-${sha}`, commit: sha }), 'Update abcdef01');
  assert.equal(releaseLabel({ version: `commit-${sha}`, commit_sha: sha, source_run_number: 42 }), 'Build 42');
  assert.equal(releaseLabel({ version: '1.9.0', commit_sha: sha }), '1.9.0');
  assert.deepEqual(
    progressSteps({ backend: 'verified', backend_deployment: 'uuid', admin: 'verifying' }),
    [{ key: 'backend', label: 'Backend', state: 'verified' }, { key: 'admin', label: 'Owner dashboard', state: 'checking' }],
  );
});
