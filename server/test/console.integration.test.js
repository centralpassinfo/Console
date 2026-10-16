'use strict';
// Drives the whole Console app, with real sessions, against a fresh local
// database and a stand-in venue backend.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test(
  'contracts, billing, operators, one-time codes and tablet approval through the full app',
  { skip: !process.env.CONSOLE_TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.CONSOLE_TEST_DATABASE_URL);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.match(url.pathname, /^\/centralpass_console_test[a-z0-9_]*$/);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      ENCRYPTION_KEY: 'a'.repeat(64),
      SESSION_SECRET: 's'.repeat(64),
      APP_ORIGIN: 'http://console.test',
      NODE_ENV: 'test',
    });
    const { pool, migrate } = require('../src/db');
    const { encryptSecret } = require('../src/crypto');
    const { generateTotpSecret, totpAt } = require('../src/totp');
    const bcrypt = require('bcryptjs');
    t.after(() => pool.end());
    assert.equal((await pool.query("SELECT to_regclass('public.venues') AS found")).rows[0].found, null, 'Use an empty test database.');
    await migrate();
    await migrate();

    // A stand-in venue backend speaking the platform-key protocol.
    const KEY = 'k'.repeat(40);
    const COMMIT = 'f'.repeat(40);
    const bundles = [
      { id: 1, app_id: 'au.test.staff', channel: 'production', version: '1.0.0', checksum: '1'.repeat(64), size_bytes: 10, min_version_code: null, notes: null, created_at: '2026-09-01T00:00:00Z', live: true, approved_at: '2026-09-01T00:00:00Z' },
      { id: 2, app_id: 'au.test.staff', channel: 'production', version: '1.1.0', checksum: '2'.repeat(64), size_bytes: 10, min_version_code: null, notes: null, created_at: '2026-10-01T00:00:00Z', live: false, approved_at: null },
    ];
    let approvals = [];
    let runningRelease = { version: `commit-${COMMIT}`, commit: COMMIT, approvalProtocol: 1 };
    const venueServer = http.createServer((req, res) => {
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-platform-key'] !== KEY) return send(401, { error: 'Invalid platform key' });
      if (req.url === '/api/platform/status') return send(200, { status: 'ok', release: runningRelease, registry: [], assignments: {}, features: {}, counts: { orders_today: 0, customers: 0 } });
      if (req.url === '/api/platform/audit') return send(200, []);
      if (req.url === '/api/platform/releases/tablet' && req.method === 'GET') return send(200, { release: runningRelease, bundles });
      if (req.url === '/api/platform/releases/tablet' && req.method === 'PUT') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          const body = JSON.parse(raw);
          approvals.push(body);
          for (const bundle of bundles) bundle.live = bundle.checksum === body.bundle.checksum;
          send(200, { approved: true, version: body.bundle.version });
        });
        return undefined;
      }
      return send(404, { error: 'Not found' });
    });
    venueServer.listen(0, '127.0.0.1');
    await new Promise((resolve) => venueServer.once('listening', resolve));
    t.after(() => new Promise((resolve) => venueServer.close(resolve)));
    const venueApi = `http://127.0.0.1:${venueServer.address().port}`;

    const app = require('../src/app');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api/console`;

    // A tiny browser: one cookie and CSRF token per signed-in operator.
    function browser() {
      const state = { cookie: '', csrf: '' };
      return async function call(method, path, body, { form } = {}) {
        const headers = { Origin: 'http://console.test', Accept: 'application/json' };
        if (state.cookie) headers.Cookie = state.cookie;
        if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
        let payload;
        if (form) payload = form;
        else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
        const response = await fetch(base + path, { method, headers, body: payload, signal: AbortSignal.timeout(8000) });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) state.cookie = setCookie.split(';')[0];
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { json = text; }
        if (json?.csrfToken) state.csrf = json.csrfToken;
        return { status: response.status, body: json };
      };
    }

    // Each code works once, so the test moves the server's clock on by one
    // 30-second step between uses instead of waiting for real time.
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    t.after(() => { Date.now = realNow; });
    const code = (secret) => totpAt(secret, clock);
    // Operators are created the way create-admin does, with a known secret.
    async function createOperator(email, name) {
      const secret = generateTotpSecret();
      const password = `${name}-password-long-enough`;
      const { rows: [row] } = await pool.query(
        'INSERT INTO console_users(email,name,password_hash,totp_secret) VALUES($1,$2,$3,$4) RETURNING id',
        [email, name, await bcrypt.hash(password, 4), encryptSecret(secret)]
      );
      return { id: row.id, email, password, secret };
    }
    const ada = await createOperator('ada.lovelace@gmail.com', 'Ada');
    const bob = await createOperator('bob@centralpass.test', 'Bob');
    const login = (call, operator, totpCode = code(operator.secret)) =>
      call('POST', '/auth/login', { email: operator.email, password: operator.password, totpCode });

    // Sign-in: dots in a Gmail address survive, and a code works only once.
    const adaBrowser = browser();
    const adaSignInCode = code(ada.secret);
    assert.equal((await login(adaBrowser, ada, adaSignInCode)).status, 200, 'Gmail addresses with dots can sign in.');
    const replay = await login(browser(), ada);
    assert.equal(replay.status, 401, 'The same authenticator code cannot sign in twice.');
    clock += 30000;

    // Venue with a contract upload: this used to crash the server.
    const venue = (await adaBrowser('POST', '/venues', { name: 'Test Cafe', slug: 'test-cafe', apiUrl: venueApi, adminUrl: 'https://admin.test', registryStatus: 'active', billingNotes: 'Keep me', platformApiKey: KEY })).body.venue;
    const form = new FormData();
    for (const [key, value] of Object.entries({ title: 'Services agreement', status: 'signed', effectiveDate: '2026-01-01', expiryDate: '2027-06-30', signedAt: '2026-01-01', setupFee: '3500.00', monthlyFee: '250.00', autoRenews: 'false', noticePeriodDays: '30', notes: '' })) form.append(key, value);
    form.append('contractFile', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'agreement.pdf');
    const uploaded = await adaBrowser('POST', `/venues/${venue.id}/contracts`, null, { form });
    assert.equal(uploaded.status, 201, 'Contract upload responds instead of crashing.');
    assert.equal(uploaded.body.contract.expiryDate, '2027-06-30', 'Contract dates keep their calendar day.');

    // Billing: a linked contract must belong to the venue, dates stay exact,
    // and an overdue invoice reaches the venue list.
    const otherVenue = (await adaBrowser('POST', '/venues', { name: 'Other Cafe', slug: 'other-cafe', apiUrl: venueApi, platformApiKey: KEY })).body.venue;
    const invoice = { invoiceNumber: 'CP-1', kind: 'monthly', periodStart: '2026-09-01', periodEnd: '2026-09-30', issuedOn: '2026-09-01', dueOn: '2026-09-15', amount: '250.00', gst: '25.00', status: 'sent', contractId: uploaded.body.contract.id };
    assert.equal((await adaBrowser('POST', `/venues/${otherVenue.id}/billing/invoices`, { ...invoice, invoiceNumber: 'CP-X' })).status, 400, 'Another venue’s contract cannot be linked.');
    const created = await adaBrowser('POST', `/venues/${venue.id}/billing/invoices`, invoice);
    assert.equal(created.status, 201);
    assert.equal(created.body.invoice.dueOn, '2026-09-15', 'Due dates do not shift by a day.');
    await adaBrowser('POST', `/venues/${venue.id}/billing/invoices/${created.body.invoice.id}/payments`, { receivedOn: '2026-09-20', amount: '100.00', method: 'bank_transfer' });
    const ledger = await adaBrowser('GET', `/venues/${venue.id}/billing`);
    assert.equal(ledger.body.summary.nextDueOn, '2026-09-15');
    assert.equal(ledger.body.summary.outstandingCents, 17500);

    await pool.query(
      `INSERT INTO console_releases(version,commit_sha,notes,created_by) VALUES('commit-${'e'.repeat(40)}',$1,'Release','GitHub CI')`,
      ['e'.repeat(40)]
    );
    await pool.query(
      `INSERT INTO venue_release_rollouts(venue_id,release_id,status,approved_by,target_snapshot,venue_snapshot,error,finished_at)
       VALUES($1,1,'failed','Ada','{}','{}','Timed out',NOW())`,
      [venue.id]
    );
    const listed = (await adaBrowser('GET', '/venues?live=false')).body.venues.find((row) => row.id === venue.id);
    assert.equal(listed.billingSummary.state, 'overdue', 'The venue list carries billing standing for Needs attention.');
    assert.equal(listed.latestRollout.status, 'failed', 'The venue list carries the latest stopped update.');

    // An edit that leaves fields out keeps them, including a suspension.
    await adaBrowser('PUT', `/venues/${venue.id}`, { name: 'Test Cafe', slug: 'test-cafe', apiUrl: venueApi, registryStatus: 'suspended' });
    const kept = (await adaBrowser('PUT', `/venues/${venue.id}`, { name: 'Test Cafe', slug: 'test-cafe', apiUrl: venueApi })).body.venue;
    assert.equal(kept.registryStatus, 'suspended', 'Leaving out the status never reactivates a venue.');
    assert.equal(kept.billingNotes, 'Keep me');
    assert.equal(kept.adminUrl, 'https://admin.test');

    // Tablet approval needs an active venue and matches the running release.
    const tabletList = await adaBrowser('GET', `/venues/${venue.id}/tablet`);
    assert.equal(tabletList.body.available, true);
    assert.deepEqual(tabletList.body.bundles.map((bundle) => [bundle.version, bundle.live]), [['1.0.0', true], ['1.1.0', false]]);
    const approveBody = { bundleId: 2, checksum: '2'.repeat(64) };
    assert.equal((await adaBrowser('POST', `/venues/${venue.id}/tablet/approve`, approveBody)).status, 409, 'A suspended venue gets no tablet approval.');
    await adaBrowser('PUT', `/venues/${venue.id}`, { name: 'Test Cafe', slug: 'test-cafe', apiUrl: venueApi, registryStatus: 'active' });
    assert.equal((await adaBrowser('POST', `/venues/${venue.id}/tablet/approve`, { bundleId: 2, checksum: '3'.repeat(64) })).status, 409, 'Approval names the exact uploaded bytes.');
    runningRelease = null;
    assert.equal((await adaBrowser('POST', `/venues/${venue.id}/tablet/approve`, approveBody)).status, 409, 'A backend not deployed by Console cannot take an approval.');
    runningRelease = { version: `commit-${COMMIT}`, commit: COMMIT, approvalProtocol: 1 };
    const approved = await adaBrowser('POST', `/venues/${venue.id}/tablet/approve`, approveBody);
    assert.equal(approved.status, 200);
    assert.deepEqual(approvals, [{ releaseCommit: COMMIT, bundle: { appId: 'au.test.staff', channel: 'production', version: '1.1.0', checksum: '2'.repeat(64) } }]);
    const rollback = await adaBrowser('POST', `/venues/${venue.id}/tablet/approve`, { bundleId: 1, checksum: '1'.repeat(64) });
    assert.equal(rollback.status, 200, 'Approving an older bundle rolls the tablets back.');
    const audited = (await pool.query("SELECT detail FROM console_audit WHERE action='tablet.approved' ORDER BY id")).rows.map((row) => row.detail.rollback);
    assert.deepEqual(audited, [false, true]);

    // Operators: every change needs the acting operator's fresh code.
    const added = await adaBrowser('POST', '/operators', { name: 'Cleo', email: 'cleo@centralpass.test', password: 'cleo-password-long', confirmCode: '000000' });
    assert.equal(added.status, 403, 'A wrong confirmation code adds no operator.');
    assert.equal((await adaBrowser('POST', '/operators', { name: 'Cleo', email: 'cleo@centralpass.test', password: 'cleo-password-long', confirmCode: adaSignInCode })).status, 403, 'The code Ada signed in with cannot confirm a change.');
    const addedOk = await adaBrowser('POST', '/operators', { name: 'Cleo', email: 'cleo@centralpass.test', password: 'cleo-password-long', confirmCode: code(ada.secret) });
    assert.equal(addedOk.status, 201);
    assert.match(addedOk.body.authenticator.secret, /^[A-Z2-7]{32}$/);
    assert.equal(JSON.stringify((await adaBrowser('GET', '/operators')).body).includes(addedOk.body.authenticator.secret), false, 'The new key is never listed again.');
    const reused = await adaBrowser('PUT', `/operators/${bob.id}/active`, { active: false, confirmCode: code(ada.secret) });
    assert.equal(reused.status, 403, 'A code used to confirm one change cannot confirm another.');
    clock += 30000;

    // Deactivating an operator ends the session they already have.
    const bobBrowser = browser();
    assert.equal((await login(bobBrowser, bob)).status, 200);
    assert.equal((await bobBrowser('GET', '/venues?live=false')).status, 200);
    assert.equal((await adaBrowser('PUT', `/operators/${ada.id}/active`, { active: false, confirmCode: code(ada.secret) })).status, 409, 'Nobody deactivates themselves.');
    const deactivated = await adaBrowser('PUT', `/operators/${bob.id}/active`, { active: false, confirmCode: code(ada.secret) });
    assert.equal(deactivated.status, 200);
    const ended = await bobBrowser('GET', '/venues?live=false');
    assert.equal(ended.status, 401);
    assert.equal(ended.body.code, 'SESSION_ENDED');
    assert.equal((await bobBrowser('GET', '/auth/me')).body.user, null);
    clock += 30000;

    // Resetting an authenticator ends sessions too, and the old key stops working.
    const cleo = { id: addedOk.body.operator.id, email: 'cleo@centralpass.test', password: 'cleo-password-long', secret: addedOk.body.authenticator.secret };
    const cleoBrowser = browser();
    assert.equal((await login(cleoBrowser, cleo)).status, 200);
    const reset = await adaBrowser('POST', `/operators/${cleo.id}/reset`, { authenticator: true, confirmCode: code(ada.secret) });
    assert.equal(reset.status, 200);
    assert.equal((await cleoBrowser('GET', '/venues?live=false')).status, 401);
    clock += 30000;
    assert.equal((await login(browser(), cleo)).status, 401, 'The replaced key no longer signs in.');
    assert.equal((await login(browser(), { ...cleo, secret: reset.body.authenticator.secret })).status, 200);

    const actions = (await pool.query('SELECT action FROM console_audit')).rows.map((row) => row.action);
    for (const action of ['contract.uploaded', 'billing.invoice.created', 'operator.created', 'operator.deactivated', 'operator.reset'])
      assert.ok(actions.includes(action), action);
  },
);
