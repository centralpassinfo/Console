# Console billing

This is CentralPass charging venues for its own services. It does not charge restaurant customers, debit a bank account or integrate with Stripe Billing. Money is marked received only when an operator records it. The partnership is configured as **not registered for GST** by default: documents say **Invoice** and **No GST has been charged**, with the ABN in the From block.

## First setup (before enabling email)

1. Deploy the Console code together. `npm start` applies the additive, repeatable `009_billing_documents.sql` migration before serving requests. Back up the dedicated Console database first; do not run Console migrations against a venue database.
2. Open **Billing > Settings**. Enter and verify the legal partnership name, ABN, address, reply email and bank details. These are database settings, not values hardcoded in the application. The GST switch must remain off unless the business actually registers.
3. Open each venue and expand **Billing contact**. Enter the legal/billing name, address, one recipient email, optional CC addresses and monthly service description. Save separately from an invoice draft.
4. Record existing invoices before automation: CP-2026-001, 002 and 003. Select **Already issued elsewhere**; this records the ledger without emailing. Record 001's actual deposit payment once. For 002 use a $620 project line and a **-$310 deposit credit**: do not also record that deposit as a payment against 002. Record 003 as **Monthly service**, covering **4 November to 3 December 2026**, for $40. Number allocation examines all recorded numbers; the next generated number is 004. Voided numbers are never reused.
5. Review the signed contract's start date, fee, renewal and expiry. Set the automation start date only after reviewing historic invoices. Periods starting before that date are manual-only, preventing surprise back-billing. Future start dates are allowed for a planned rollout.
6. Verify the `centralpass.au` sender/domain in Brevo. On the **server service**, configure `BREVO_API_KEY`, `BILLING_FROM_EMAIL` and `BILLING_FROM_NAME`. Keep `BILLING_SEND_ENABLED=false` until the setup has been reviewed. Never put credentials in a `VITE_` variable or commit `.env`.
7. Preview a draft and download its PDF. Check recipient, credit lines, amount, bank reference and GST wording. When ready, set `BILLING_SEND_ENABLED=true` on the server. This enables explicit manual sending; **auto_send** and **auto_remind** still start off and require separate opt-in.

This implementation does not prefill real bank details, import real invoices, enable sending, verify DNS or send a test email on your behalf.

## Daily workflow

- **Billing > Invoices** lists the latest 200 invoices. A venue link opens its full billing ledger. Search by number, venue or state.
- **New invoice** saves a draft by default. Leave the number blank for `CP-YYYY-NNN`, or enter a historic invoice number. Add up to 30 lines, including negative credits; the net amount cannot be negative. Currency is AUD and cents are exact. GST, when registration is explicitly enabled, is calculated at 10% of the exclusive line total.
- **Preview & send** shows the document model, recipient, bank details and email history. PDF download renders the same model server-side with PDFKit, without requiring Chromium in production.
- A draft may be edited with a current timestamp. Issued/uncertain invoices cannot have their financial fields rewritten; void a mistaken unpaid invoice and issue a replacement. Void or written-off invoices cannot be emailed. Received payments protect against voiding an invoice accidentally.
- **Record payment** records money that actually arrived. Dates cannot be in the future, amounts must be positive and cannot exceed the remaining balance. Requests have an idempotency key. Provider payments cannot be manually deleted. Every manual payment removal is audited.
- Once fully paid, **Preview & send > Paid-in-full receipt** sends a PAID version without How to pay. Receipts are deliberately manual, not a side effect of editing a payment.

## Monthly run

The API checks ten seconds after startup, then hourly while the Console process is running. Multiple instances coordinate with a PostgreSQL advisory lock. No separate scheduler service is required. If the application sleeps, checks resume when it wakes; this is not an always-on external scheduler.

The database pool needs at least two connections (the default is ten): one holds the run lock while another executes transactions. A smaller configured pool is rejected rather than hanging the billing run.

- **auto_generate** defaults on, but no drafts are generated before an automation start date is set. **auto_send** and **auto_remind** default off. The server email kill switch independently disables all outgoing messages.
- Automatic sending applies only to drafts created in that run. Enabling it does not unexpectedly email a backlog of old drafts. Review and send earlier drafts manually, including a draft left behind if a process stopped between generation and sending.
- **Preview run** is read-only. **Run billing check** generates eligible drafts even when scheduled generation is off, and honors the sending/reminder switches. When those switches are on, the UI warns that the run can send email.
- Each active venue uses its latest applicable signed contract. A later expired or terminated contract stops an older signed agreement from silently resuming billing. Future contracts do not take over early. Suspended/offboarded venues are skipped.
- Periods stay anchored to the original start day: 4 Nov–3 Dec, 4 Dec–3 Jan. A 31st anchor clamps in shorter months, then returns to the 31st. A non-renewing contract ending mid-period is charged by covered days, rounded once to cents. Payment is due seven days after issue by default.
- Only the current missing period is considered; historical cycles are not bulk backfilled. Any overlapping non-void monthly invoice, including a draft or manually recorded invoice, blocks a second invoice. Venue-level transaction locks prevent concurrent generation/import races.
- The issue date is the day the draft is generated; the service period retains its anniversary boundaries. A restart mid-period may therefore create a current-period draft, not a false claim that an invoice was sent earlier. Drafts are reviewable before sending unless auto_send is explicitly enabled.
- Reminders only follow an invoice actually accepted by Brevo through Console and still owing money: two days before due, then 1, 7 and 14 days overdue. Only the latest reached stage is considered. Sent/uncertain stages are not repeated, and settled/void/written-off invoices are excluded. Legacy “issued elsewhere” invoices are not automatically chased.
- Last-run results and errors appear in Monthly run; every run also has an Activity audit entry.

## Delivery safety and meaning of statuses

Every actual attempt is inserted durably before a provider call, with its recipient, subject, document model, purpose and UUID provider key. One logical initial invoice, receipt or reminder stage can be claimed once. Resends require an explicit confirmation and a new request ID; retries of that same request reuse the ID.

- **Accepted by Brevo** means the provider returned a message ID. It does **not** establish inbox delivery, reading or payment. Delivery/bounce webhooks are not implemented in this milestone; check Brevo's transactional activity.
- **Rejected** means a definitive rejection or a local rendering failure before submission. It stays visible for operator review, not an automatic retry loop.
- **Uncertain** means the network/provider result could not be established. A worker interrupted with an in-progress attempt is marked uncertain after five minutes. The invoice remains protected against rewriting. Check Brevo activity before explicitly sending another copy. Never retry uncertain messages automatically: Brevo's idempotency protection is time-bounded, not a permanent guarantee.
- Invoice edits, payments and status changes are blocked during an in-progress send. Email outcomes and financial changes are audited. The originally issued seller/buyer, tax registration and line details remain fixed even after settings change. Current payment state is reflected in subsequent downloads/receipts. Email recipients use the current billing contact.

## API and tests

All endpoints require a live Console operator session; writes require CSRF and existing origin checks. PDF downloads are authenticated, venue-scoped and no-store.

- `/api/console/billing`: overview; `/settings`: GET/PUT; `/run-preview`: GET; `/run`: POST.
- `/api/console/venues/:venueId/billing`: full ledger/settings/contact/email history.
- `/contact`: PUT; `/invoices`: POST; `/invoices/:invoiceId`: PUT (draft only).
- `/invoices/:invoiceId/preview`: GET; `/pdf`: GET; `/send`: POST (`purpose: invoice|receipt`, explicit `resend` and `requestId` for another copy).
- `/invoices/:invoiceId/status`: POST; `/payments`: POST with a stable `requestId`.
- `/billing/payments/:paymentId`: DELETE for manual payments only.

Run `npm test` and `npm run build`. Database tests require a **fresh, empty loopback-only** database named `centralpass_console_test_billing...` via `BILLING_TEST_DATABASE_URL`; they refuse an existing or nonlocal database. Existing Console HTTP tests use their own empty database via `CONSOLE_TEST_DATABASE_URL`. All email tests inject a fake sender or fake fetch; no messages are sent. Local browser checks use synthetic invoices and sending disabled.

References: [Brevo transactional endpoint](https://developers.brevo.com/reference/send-transac-email), [Brevo idempotency (UUID keys, 30-minute window)](https://developers.brevo.com/docs/heterogenous-versions-batch-emails), [Australian Government invoice guidance](https://business.gov.au/finance/payments-and-invoicing/how-to-invoice). These describe integration/document rules; this is not verification of a business's registration status.

## Local verification — 3 November 2026

- Full Console test run: 80 passed, 3 unrelated release/database suites skipped. The billing database suite uses a fake sender and includes numbering concurrency, period overlaps, stale settings, snapshot retention, repeated payment requests, provider failure/ambiguity, interrupted worker recovery, automatic sending without a backlog and authenticated HTTP/PDF boundaries. The existing Console contracts/operators/tablet HTTP test also passes separately and as part of the run.
- Production frontend build passes. Local Chromium checks cover settings, manual run preview/execution, a two-line $620 less $310 draft, PDF download, recording payment, the paid receipt and disabled sending, at desktop/390px/320px widths. No runtime errors were observed. Visual review corrected header spacing and a narrow-dialog icon overlap.
- Sample, paid and 30-line/four-page PDFs were rendered and inspected; no clipping or overlapping content was observed. The invoice layout was compared with the supplied reference invoices.
- This is local evidence only. No production migration, deployment, real invoice import, live sender verification or real email was performed.
