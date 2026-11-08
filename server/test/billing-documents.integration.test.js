'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('crypto');
test(
  'billing documents, generation, delivery recovery and authenticated HTTP',
  { skip: !process.env.BILLING_TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.match(url.pathname, /^\/centralpass_console_test_billing[a-z0-9_]*$/);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      ENCRYPTION_KEY: 'a'.repeat(64),
      SESSION_SECRET: 's'.repeat(64),
      APP_ORIGIN: 'http://console.test',
      NODE_ENV: 'test',
      BILLING_SEND_ENABLED: 'false',
    });
    const { pool, migrate } = require('../src/db');
    t.after(() => pool.end());
    assert.equal(
      (await pool.query("SELECT to_regclass('public.venues') AS found")).rows[0].found,
      null,
      'Use an empty billing test database.',
    );
    await migrate();
    await migrate();
    const { createBillingService } = require('../src/billing-service');
    let now = new Date('2026-12-04T04:00:00Z'),
      calls = 0,
      sendMode = 'ok',
      waiting,
      release;
    const env = {
      BREVO_API_KEY: 'synthetic',
      BILLING_FROM_EMAIL: 'accounts@example.test',
      BILLING_SEND_ENABLED: 'true',
    };
    const send = async (payload) => {
      calls++;
      assert.match(payload.operationKey, /^[a-f0-9-]{36}$/);
      assert.ok(payload.attachments[0].content.length);
      if (sendMode === 'hold') {
        waiting();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      if (sendMode === 'unknown') throw Error('network lost');
      if (sendMode === 'failed') {
        const error = Error('rejected');
        error.definitive = true;
        throw error;
      }
      return { messageId: 'qa-' + calls };
    };
    const service = createBillingService({
      db: pool,
      send,
      render: async () => Buffer.from('%PDF-qa'),
      env,
      now: () => now,
    });
    const actor = 'QA operator';
    await service.updateSettings(
      {
        ...(await service.settings()),
        seller_legal_name: 'QA Partnership trading as CentralPass',
        abn: '51824753556',
        address: 'Test street',
        email: 'accounts@example.test',
        bank_account_name: 'QA',
        bank_bsb: '000000',
        bank_account_number: '99999999',
        automation_start_on: '2026-11-04',
      },
      actor,
    );
    let sequence = 0;
    async function buyer() {
      const row = (
        await pool.query(
          "INSERT INTO venues(name,slug,api_url,platform_api_key,billing_email,billing_address) VALUES($1,$2,'http://127.0.0.1:1','synthetic','qa@example.test','Test road') RETURNING *",
          ['QA Cafe ' + ++sequence, 'qa-' + sequence],
        )
      ).rows[0];
      return row;
    }
    async function contract(venueId, extra = {}) {
      return (
        await pool.query(
          "INSERT INTO venue_contracts(venue_id,title,status,effective_date,expiry_date,monthly_fee_cents,auto_renews,original_filename,file_size_bytes,encrypted_file,file_sha256,created_by) VALUES($1,'QA contract',$2,$3,$4,4000,$5,'qa.pdf',12,$6,$7,'QA') RETURNING *",
          [
            venueId,
            extra.status || 'signed',
            extra.start || '2026-11-04',
            extra.end || null,
            extra.renews ?? true,
            Buffer.from('%PDF-qa'),
            '0'.repeat(64),
          ],
        )
      ).rows[0];
    }
    const draft = (overrides) => ({
      kind: 'setup',
      issuedOn: '2026-11-04',
      dueOn: '2026-11-11',
      lines: [
        { description: 'Project', amount: '620' },
        { description: 'Deposit credit', amount: '-310' },
      ],
      ...overrides,
    });
    const primary = await buyer();
    const agreement = await contract(primary.id);
    let issued, first;
    await t.test(
      'manual historical numbering carries forward without consuming a phantom number',
      async () => {
        await service.saveInvoice(
          primary.id,
          null,
          draft({ invoiceNumber: 'CP-2026-001', status: 'sent' }),
          actor,
        );
        await service.saveInvoice(
          primary.id,
          null,
          draft({ invoiceNumber: 'CP-2026-002', status: 'sent' }),
          actor,
        );
        await service.saveInvoice(
          primary.id,
          null,
          draft({
            invoiceNumber: 'CP-2026-003',
            kind: 'monthly',
            status: 'sent',
            periodStart: '2026-11-04',
            periodEnd: '2026-12-03',
            contractId: agreement.id,
            lines: [{ description: 'Monthly', amount: '40' }],
          }),
          actor,
        );
        first = await service.saveInvoice(primary.id, null, draft(), actor);
        assert.equal(first.invoiceNumber, 'CP-2026-004');
        assert.equal(first.amountCents, 31000);
        assert.equal(first.gstCents, 0);
        assert.equal(
          (await service.ledger(primary.id)).invoices.find((row) => row.id === first.id).lines
            .length,
          2,
        );
      },
    );
    await t.test(
      'draft edits require the current timestamp and issued fields cannot be rewritten',
      async () => {
        await assert.rejects(
          service.saveInvoice(primary.id, first.id, draft({ updatedAt: '2000-01-01' }), actor),
          { status: 409 },
        );
        first = await service.saveInvoice(
          primary.id,
          first.id,
          draft({ updatedAt: first.updatedAt, notes: 'Revised draft' }),
          actor,
        );
        assert.equal(first.notes, 'Revised draft');
        await assert.rejects(
          service.saveInvoice(primary.id, 1, draft({ updatedAt: first.updatedAt }), actor),
          { status: 409 },
        );
      },
    );
    await t.test(
      'overlapping monthly periods cannot bypass existing-period detection',
      async () => {
        await assert.rejects(
          service.saveInvoice(
            primary.id,
            null,
            draft({ kind: 'monthly', periodStart: '2026-11-18', periodEnd: '2026-12-10' }),
            actor,
          ),
          { status: 409 },
        );
        const preview = await service.preview('2026-11-04');
        assert.match(
          preview.venues.find((item) => item.venueId === primary.id).reason,
          /Already invoiced/,
        );
      },
    );
    await t.test(
      'create retries reuse a request ID without duplicating a setup invoice',
      async () => {
        const value = draft({ requestId: crypto.randomUUID() });
        const a = await service.saveInvoice(primary.id, null, value, actor),
          b = await service.saveInvoice(primary.id, null, value, actor);
        assert.equal(a.id, b.id);
      },
    );
    await t.test('stale billing settings cannot silently overwrite bank details', async () => {
      const original = await service.settings();
      await service.updateSettings({ ...original, bank_account_name: 'Updated QA account' }, actor);
      await assert.rejects(
        service.updateSettings({ ...original, bank_account_name: 'Stale bank edit' }, actor),
        { status: 409 },
      );
      assert.equal((await service.settings()).bank_account_name, 'Updated QA account');
    });
    await t.test('concurrent numbering and monthly checks never duplicate an invoice', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => service.saveInvoice(primary.id, null, draft(), actor)),
      );
      assert.equal(new Set(results.map((item) => item.invoiceNumber)).size, 6);
      await Promise.all([
        service.run({ manual: true, actor }),
        service.run({ manual: true, actor }),
      ]);
      const rows = (
        await pool.query(
          "SELECT * FROM venue_invoices WHERE venue_id=$1 AND kind='monthly' AND period_start='2026-12-04'",
          [primary.id],
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'draft');
      assert.equal(calls, 0);
      assert.equal((await service.run({ manual: true, actor })).created.length, 0);
    });
    await t.test(
      'no billing begins before historic review; suspended, expired and terminated contracts skip',
      async () => {
        const other = await buyer();
        await contract(other.id);
        await contract(other.id, { status: 'terminated', start: '2026-12-01' });
        assert.match(
          (await service.preview()).venues.find((item) => item.venueId === other.id).reason,
          /No signed/,
        );
        await pool.query("UPDATE venues SET status='suspended' WHERE id=$1", [other.id]);
        assert.match(
          (await service.preview()).venues.find((item) => item.venueId === other.id).reason,
          /suspended/,
        );
        const notStarted = await buyer();
        await contract(notStarted.id);
        await service.updateSettings(
          { ...(await service.settings()), automation_start_on: null },
          actor,
        );
        assert.equal((await service.run({ manual: true, actor })).created.length, 0);
        await service.updateSettings(
          { ...(await service.settings()), automation_start_on: '2026-11-04' },
          actor,
        );
      },
    );
    await t.test('sending is disabled by an independent server switch', async () => {
      const disabled = createBillingService({
        db: pool,
        send,
        env: { ...env, BILLING_SEND_ENABLED: 'false' },
        now: () => now,
      });
      await assert.rejects(disabled.deliver(primary.id, first.id, {}, actor), { status: 409 });
      assert.equal(calls, 0);
    });
    await t.test(
      'concurrent send clicks make one durable attempt and block changes while sending',
      async () => {
        let started;
        const start = new Promise((resolve) => {
          started = resolve;
        });
        waiting = started;
        sendMode = 'hold';
        const pending = service.deliver(primary.id, first.id, {}, actor);
        await start;
        assert.equal((await service.deliver(primary.id, first.id, {}, actor)).duplicate, true);
        await assert.rejects(
          service.saveInvoice(primary.id, first.id, draft({ updatedAt: first.updatedAt }), actor),
          { status: 409 },
        );
        release();
        const result = await pending;
        assert.equal(result.email.status, 'sent');
        sendMode = 'ok';
        assert.equal(calls, 1);
        issued = (await service.ledger(primary.id)).invoices.find((item) => item.id === first.id);
        assert.equal(issued.status, 'sent');
        assert.ok(issued.sentAt);
      },
    );
    await t.test(
      'issued seller/buyer snapshots survive edits and GST registration changes',
      async () => {
        const before = await service.document(primary.id, first.id);
        await service.updateSettings(
          {
            ...(await service.settings()),
            seller_legal_name: 'Changed future seller',
            gst_registered: true,
          },
          actor,
        );
        await service.updateContact(
          primary.id,
          {
            billing_name: 'New buyer name',
            billing_email: 'changed@example.test',
            billing_address: 'New address',
          },
          actor,
        );
        const after = await service.document(primary.id, first.id);
        assert.deepEqual(after.from, before.from);
        assert.deepEqual(after.billTo, before.billTo);
        assert.equal(after.title, 'Invoice');
        await service.updateSettings(
          { ...(await service.settings()), gst_registered: false },
          actor,
        );
      },
    );
    await t.test(
      'payments are idempotent, overpayment is refused, paid receipts have no payment panel',
      async () => {
        const payment = {
          receivedOn: '2026-12-04',
          amount: '310.00',
          method: 'bank_transfer',
          requestId: crypto.randomUUID(),
        };
        const one = await service.recordPayment(primary.id, first.id, payment, actor),
          two = await service.recordPayment(primary.id, first.id, payment, actor);
        assert.equal(one.payment.id, two.payment.id);
        assert.equal(one.billing.state, 'paid');
        await assert.rejects(
          service.recordPayment(
            primary.id,
            first.id,
            { ...payment, requestId: crypto.randomUUID() },
            actor,
          ),
          { status: 409 },
        );
        assert.equal((await service.document(primary.id, first.id)).pay, null);
        assert.equal(
          (await service.deliver(primary.id, first.id, { purpose: 'receipt' }, actor)).email.status,
          'sent',
        );
        assert.equal(
          (await service.deliver(primary.id, first.id, { purpose: 'receipt' }, actor)).duplicate,
          true,
        );
      },
    );
    await t.test('network ambiguity is recorded and never retried by repeated sends', async () => {
      const row = await service.saveInvoice(primary.id, null, draft(), actor);
      sendMode = 'unknown';
      const result = await service.deliver(primary.id, row.id, {}, actor);
      assert.equal(result.email.status, 'unknown');
      const before = calls;
      assert.equal((await service.deliver(primary.id, row.id, {}, actor)).duplicate, true);
      assert.equal(calls, before);
      sendMode = 'ok';
      await assert.rejects(
        service.saveInvoice(primary.id, row.id, draft({ updatedAt: row.updatedAt }), actor),
        { status: 409 },
      );
      assert.equal(
        (
          await service.deliver(
            primary.id,
            row.id,
            { resend: true, requestId: crypto.randomUUID() },
            actor,
          )
        ).email.status,
        'sent',
      );
    });
    await t.test(
      'a definitive provider rejection stays visible and leaves an unsent draft editable',
      async () => {
        const row = await service.saveInvoice(primary.id, null, draft(), actor);
        sendMode = 'failed';
        const result = await service.deliver(primary.id, row.id, {}, actor);
        assert.equal(result.email.status, 'failed');
        sendMode = 'ok';
        assert.equal(
          (await service.ledger(primary.id)).invoices.find((item) => item.id === row.id).status,
          'draft',
        );
      },
    );
    await t.test(
      'reminders use only the latest due stage and do not repeat or follow paid invoices',
      async () => {
        const row = await service.saveInvoice(primary.id, null, draft(), actor);
        await service.deliver(primary.id, row.id, {}, actor);
        const sent = await service.deliver(
          primary.id,
          row.id,
          { purpose: 'reminder', reminderKey: 'overdue-14' },
          actor,
        );
        assert.equal(sent.email.status, 'sent');
        await assert.rejects(
          service.deliver(
            primary.id,
            first.id,
            { purpose: 'reminder', reminderKey: 'overdue-14' },
            actor,
          ),
          { status: 409 },
        );
        assert.equal(
          (
            await service.deliver(
              primary.id,
              row.id,
              { purpose: 'reminder', reminderKey: 'overdue-14' },
              actor,
            )
          ).duplicate,
          true,
        );
      },
    );
    await t.test(
      'automatic sending only handles newly generated drafts, not a backlog',
      async () => {
        const backlog = (
          await pool.query(
            "SELECT id FROM venue_invoices WHERE origin='automatic' AND status='draft'",
          )
        ).rows.map((row) => row.id);
        const fresh = await buyer();
        await contract(fresh.id);
        await service.updateSettings({ ...(await service.settings()), auto_send: true }, actor);
        const result = await service.run({ actor });
        assert.ok(result.created.length > 0);
        assert.equal(result.emails.length, result.created.length);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM venue_invoices WHERE id=ANY($1::int[]) AND status='draft'",
              [backlog],
            )
          ).rows[0].count,
          backlog.length,
        );
        await service.updateSettings({ ...(await service.settings()), auto_send: false }, actor);
      },
    );
    await t.test(
      'interrupted attempts become uncertain without resending and protect the draft',
      async () => {
        const row = await service.saveInvoice(primary.id, null, draft(), actor);
        await pool.query(
          "INSERT INTO venue_invoice_emails(invoice_id,venue_id,purpose,to_email,subject,status,operation_key,provider_key,sent_by,created_at) VALUES($1,$2,'invoice','qa@example.test','Interrupted','sending',$3,$4,'QA',NOW()-INTERVAL '10 minutes')",
          [row.id, primary.id, `invoice:${row.id}:initial`, crypto.randomUUID()],
        );
        const before = calls;
        await service.run({ actor });
        const attempt = (
          await pool.query('SELECT status FROM venue_invoice_emails WHERE invoice_id=$1', [row.id])
        ).rows[0];
        assert.equal(attempt.status, 'unknown');
        assert.equal(calls, before);
        assert.equal((await service.deliver(primary.id, row.id, {}, actor)).duplicate, true);
        await assert.rejects(
          service.saveInvoice(primary.id, row.id, draft({ updatedAt: row.updatedAt }), actor),
          { status: 409 },
        );
      },
    );
    await t.test(
      'real HTTP requires authentication and CSRF, scopes venue PDFs and respects sending switch',
      async () => {
        const { encryptSecret } = require('../src/crypto'),
          { generateTotpSecret, totpAt } = require('../src/totp'),
          bcrypt = require('bcryptjs');
        const secret = generateTotpSecret();
        await pool.query(
          "INSERT INTO console_users(email,name,password_hash,totp_secret) VALUES('qa@example.test','QA operator',$1,$2)",
          [await bcrypt.hash('qa-password-long', 4), encryptSecret(secret)],
        );
        const server = require('../src/app').listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        t.after(
          () =>
            new Promise((resolve) => {
              server.closeAllConnections();
              server.close(resolve);
            }),
        );
        const fetch = (path, options = {}) =>
          globalThis
            .fetch(path, { ...options, signal: AbortSignal.timeout(8000) })
            .catch((error) => {
              throw new Error(`HTTP fixture failed at ${path}: ${error.message}`);
            });
        const base = `http://127.0.0.1:${server.address().port}/api/console`;
        assert.equal((await fetch(base + '/billing')).status, 401);
        const login = await fetch(base + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://console.test' },
          body: JSON.stringify({
            email: 'qa@example.test',
            password: 'qa-password-long',
            totpCode: totpAt(secret),
          }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';')[0],
          session = await login.json();
        assert.equal(
          (
            await fetch(base + '/billing/settings', {
              method: 'PUT',
              headers: { Cookie: cookie, 'Content-Type': 'application/json' },
              body: '{}',
            })
          ).status,
          403,
        );
        assert.equal((await fetch(base + '/billing', { headers: { Cookie: cookie } })).status, 200);
        const path = `/venues/${primary.id}/billing/invoices/${first.id}`;
        const pdf = await fetch(base + path + '/pdf', { headers: { Cookie: cookie } });
        assert.equal(pdf.status, 200);
        assert.equal(pdf.headers.get('cache-control'), 'no-store');
        assert.ok(
          Buffer.from(await pdf.arrayBuffer())
            .subarray(0, 8)
            .toString()
            .startsWith('%PDF-'),
        );
        const other = await buyer();
        assert.equal(
          (
            await fetch(base + `/venues/${other.id}/billing/invoices/${first.id}/pdf`, {
              headers: { Cookie: cookie },
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await fetch(base + path + '/send', {
              method: 'POST',
              headers: {
                Cookie: cookie,
                'Content-Type': 'application/json',
                'X-CSRF-Token': session.csrfToken,
              },
              body: '{}',
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await fetch(base + '/billing/run-preview?date=2026-02-30', {
              headers: { Cookie: cookie },
            })
          ).status,
          400,
        );
      },
    );
  },
);
