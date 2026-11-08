'use strict';

/**
 * The invoice document, in two halves:
 *
 *   buildInvoiceDocument()  pure: turns ledger rows into exactly what is printed
 *   renderInvoicePdf()      draws that model as an A4 PDF
 *
 * The layout reproduces the invoices CentralPass first issued by hand
 * (wild-sun-site/output/invoices): logo and wordmark, "Invoice" with a status
 * badge, a plum rule, From / Bill to / Details, the description table, totals,
 * a How to pay panel and a footnote. The PDF always reflects the invoice's
 * current state, so downloading a paid invoice gives the PAID version.
 *
 * Rendered with pdfkit rather than a headless browser so the Console does not
 * need Chromium on Railway. pdfkit's built-in Helvetica and Times stand in for
 * the original's Segoe UI and Georgia.
 */

const PDFDocument = require('pdfkit');
const { longDate, money, periodLabel } = require('./billing-calendar');

const KIND_FALLBACK = {
  monthly: 'CentralPass platform, hosting and support',
  setup: 'Setup and onboarding',
  usage: 'Usage above the included allowance',
  other: 'Services',
};

function lines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Everything printed on the invoice, worked out once. `description` is the
 * derived billing state from billing.js (paid, outstanding, state).
 */
function buildInvoiceDocument({
  invoice,
  lineItems = [],
  payments = [],
  description,
  settings,
  venue,
}) {
  const registered = Boolean(settings.gst_registered);
  const state = description?.state || invoice.status;
  const paidCents = description?.paidCents ?? 0;
  const totalCents = Number(invoice.amount_cents) + Number(invoice.gst_cents || 0);
  const dueCents = ['void', 'written_off'].includes(state)
    ? 0
    : Math.max(0, totalCents - paidCents);
  const isPaid = state === 'paid';

  // An invoice recorded before line items existed renders as a single line.
  const items = lineItems.length
    ? [...lineItems]
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((l) => ({
          description: l.description,
          detail: l.detail || '',
          amountCents: Number(l.amount_cents ?? l.amountCents),
          credit: Number(l.amount_cents ?? l.amountCents) < 0,
        }))
    : [
        {
          description: KIND_FALLBACK[invoice.kind] || KIND_FALLBACK.other,
          detail: [
            invoice.period_start && invoice.period_end
              ? `${invoice.kind === 'monthly' ? 'Monthly, ' : ''}${periodLabel(invoice.period_start, invoice.period_end)}`
              : '',
            invoice.notes || '',
          ]
            .filter(Boolean)
            .join(' · '),
          amountCents: Number(invoice.amount_cents),
          credit: false,
        },
      ];

  const badge = {
    paid: { label: 'PAID', tone: 'paid' },
    void: { label: 'VOID', tone: 'void' },
    written_off: { label: 'WRITTEN OFF', tone: 'void' },
    draft: { label: 'DRAFT', tone: 'draft' },
  }[state] || {
    label: state === 'overdue' ? 'OVERDUE' : 'AMOUNT DUE',
    tone: state === 'overdue' ? 'overdue' : 'due',
  };

  const details = [
    ['Invoice', invoice.invoice_number],
    ['Date', longDate(invoice.issued_on)],
  ];
  if (isPaid) details.push(['Status', 'Paid']);
  else details.push(['Due', longDate(invoice.due_on)]);

  const from = [
    settings.seller_legal_name || settings.seller_name,
    settings.abn ? `ABN ${settings.abn}` : null,
    ...lines(settings.address),
    settings.email,
  ].filter(Boolean);

  const billTo = [venue.billing_name || venue.name, ...lines(venue.billing_address)];

  const bankReady = settings.bank_account_name && settings.bank_bsb && settings.bank_account_number;
  const showPay = dueCents > 0 && !['void', 'written_off'].includes(state);

  let footnote = invoice.footnote || '';
  if (isPaid)
    footnote = `Thank you. This invoice has been paid in full.${footnote ? ` ${footnote}` : ''}`;
  if (settings.email) footnote = `${footnote}${footnote ? ' ' : ''}Questions: ${settings.email}`;

  return {
    title: registered ? 'Tax invoice' : 'Invoice',
    sellerName: settings.seller_name || 'CentralPass',
    badge,
    from,
    billTo,
    details,
    items,
    totalCents,
    gstCents: Number(invoice.gst_cents || 0),
    gstRegistered: registered,
    paidCents,
    dueCents,
    pay: showPay
      ? {
          ready: Boolean(bankReady),
          rows: [
            ['Account name', settings.bank_account_name || '—'],
            ['BSB', settings.bank_bsb || '—'],
            ['Account number', settings.bank_account_number || '—'],
            ['Reference', invoice.invoice_number],
          ],
        }
      : null,
    footnote,
    missing: [
      !settings.abn && 'ABN',
      !settings.address && 'business address',
      showPay && !bankReady && 'bank details',
      !venue.billing_address && 'venue billing address',
    ].filter(Boolean),
  };
}

// ── Drawing ──────────────────────────────────────────────────────────────────

const C = {
  plum: '#3b1d4a',
  text: '#1f1a24',
  muted: '#6c6474',
  rule: '#d9d3dd',
  ruleSoft: '#ece8ef',
  panel: '#f6f3f8',
  teal: '#2f8f83',
};
const BADGE = {
  paid: ['#e3f1ea', '#1d6b43'],
  due: ['#fbf0d9', '#7a5300'],
  overdue: ['#fbe4e2', '#9c2f27'],
  draft: ['#ecebef', '#555159'],
  void: ['#ecebef', '#555159'],
};

// The CentralPass mark: four opaque, offset planes (viewBox 0 0 394 438).
const MARK = [
  ['M139 80C139 69 148 62 159 65L274 96C284 99 291 107 291 118V228L139 261Z', '#176F6A'],
  [
    'M62 159C62 149 70 142 81 141L178 133C189 132 198 140 198 151V342C198 353 190 361 179 361H81C70 361 62 353 62 342Z',
    '#432044',
  ],
  [
    'M188 191C188 181 195 174 206 172L311 165C322 164 331 172 331 183V350C331 360 324 368 313 370L208 383C197 384 188 376 188 365Z',
    '#D99B19',
  ],
  [
    'M151 198C151 188 156 184 163 181L225 162C234 159 241 165 241 175V316C241 326 234 332 225 330L163 312C155 310 151 305 151 297Z',
    '#FFF8EC',
  ],
];

const MM = 72 / 25.4;

/** Draw the document to a PDF and resolve with the bytes. */
function renderInvoicePdf(doc) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 18 * MM, bottom: 18 * MM, left: 16 * MM, right: 16 * MM },
      info: {
        Title: `${doc.title} ${doc.details[0][1]}`,
        Author: doc.sellerName,
        Creator: 'CentralPass Console',
      },
    });
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = pdf.page.margins.left;
    const right = pdf.page.width - pdf.page.margins.right;
    const width = right - left;
    let y = pdf.page.margins.top;
    const ensureSpace = (height) => {
      if (y + height <= pdf.page.height - pdf.page.margins.bottom) return false;
      pdf.addPage();
      y = pdf.page.margins.top;
      pdf
        .font('Helvetica')
        .fontSize(8)
        .fillColor(C.muted)
        .text(`${doc.title} ${doc.details[0][1]} - continued`, left, y, { width });
      y += 24;
      return true;
    };

    // ── Header: mark, wordmark, title and badge ──
    pdf
      .save()
      .translate(left - 3, y - 4)
      .scale(34 / 394);
    for (const [d, fill] of MARK) pdf.path(d).fill(fill);
    pdf.restore();
    pdf
      .font('Times-Bold')
      .fontSize(19)
      .fillColor(C.plum)
      .text(doc.sellerName, left + 38, y + 5, { lineBreak: false });

    pdf
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(C.plum)
      .text(doc.title, left, y - 2, { width, align: 'right' });
    pdf.font('Helvetica-Bold').fontSize(8);
    const badgeW = pdf.widthOfString(doc.badge.label) + 18;
    const [badgeBg, badgeFg] = BADGE[doc.badge.tone] || BADGE.due;
    pdf.roundedRect(right - badgeW, y + 24, badgeW, 15, 2).fill(badgeBg);
    pdf
      .fillColor(badgeFg)
      .text(doc.badge.label, right - badgeW, y + 28.5, {
        width: badgeW,
        align: 'center',
        characterSpacing: 0.3,
      });

    y += 48;
    pdf.rect(left, y, width, 2.2).fill(C.plum);
    y += 18;

    // ── From / Bill to / Details ──
    const gap = 18;
    const colW = (width - gap * 2) / 3;
    const colX = [left, left + colW + gap, left + (colW + gap) * 2];
    const heading = (text, x, top) => {
      pdf
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor(C.muted)
        .text(text.toUpperCase(), x, top, { width: colW, characterSpacing: 0.8 });
    };
    heading('From', colX[0], y);
    heading('Bill to', colX[1], y);
    heading('Details', colX[2], y);
    const blockTop = y + 15;
    pdf.font('Helvetica').fontSize(9.5).fillColor(C.text);
    pdf.text(doc.from.join('\n'), colX[0], blockTop, { width: colW, lineGap: 2.5 });
    const fromBottom = pdf.y;
    pdf.text(doc.billTo.join('\n'), colX[1], blockTop, { width: colW, lineGap: 2.5 });
    const billBottom = pdf.y;
    let dy = blockTop;
    for (const [label, value] of doc.details) {
      pdf.fillColor(C.muted).text(label, colX[2], dy, { width: 46, lineBreak: false });
      pdf.fillColor(C.text).text(value, colX[2] + 50, dy, { width: colW - 50 });
      dy = pdf.y + 2.5;
    }
    y = Math.max(fromBottom, billBottom, dy) + 22;

    // ── Items ──
    const amountW = 90;
    const descW = width - amountW - 20;
    pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(C.muted);
    pdf.text('DESCRIPTION', left, y, { characterSpacing: 0.8, lineBreak: false });
    pdf.text(doc.gstRegistered ? 'AMOUNT (EX. GST)' : 'AMOUNT', right - amountW, y, {
      width: amountW,
      align: 'right',
      characterSpacing: 0.8,
    });
    y += 14;
    pdf.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(C.rule).stroke();
    y += 9;

    for (const item of doc.items) {
      pdf.font('Helvetica').fontSize(9.5);
      const descriptionHeight = pdf.heightOfString(item.description, {
        width: descW,
        lineGap: 1.5,
      });
      pdf.fontSize(8);
      const detailHeight = item.detail ? pdf.heightOfString(item.detail, { width: descW }) + 2 : 0;
      ensureSpace(descriptionHeight + detailHeight + 30);
      const top = y;
      pdf
        .font('Helvetica')
        .fontSize(9.5)
        .fillColor(item.credit ? C.muted : C.text);
      pdf.text(item.description, left, top, { width: descW, lineGap: 1.5 });
      if (item.detail) {
        pdf
          .font('Helvetica')
          .fontSize(8)
          .fillColor(C.muted)
          .text(item.detail, left, pdf.y + 1, { width: descW });
      }
      const rowBottom = pdf.y;
      pdf
        .font('Helvetica')
        .fontSize(9.5)
        .fillColor(item.credit ? C.muted : C.text)
        .text(money(item.amountCents), right - amountW, top, { width: amountW, align: 'right' });
      y = Math.max(rowBottom, pdf.y) + 9;
      pdf.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(C.ruleSoft).stroke();
      y += 9;
    }

    // ── Totals ──
    ensureSpace(140);
    const tW = 200;
    const tX = right - tW;
    const row = (label, value, { muted = false, size = 9.5 } = {}) => {
      pdf
        .font('Helvetica')
        .fontSize(size)
        .fillColor(muted ? C.muted : C.text);
      pdf.text(label, tX, y, { width: tW - 90, lineBreak: false });
      pdf.text(value, tX, y, { width: tW, align: 'right' });
      y += size + 8;
    };
    y += 4;
    row(doc.gstRegistered ? 'Total (inc. GST)' : 'Total', money(doc.totalCents));
    if (doc.gstRegistered) row('Includes GST of', money(doc.gstCents), { muted: true, size: 8.5 });
    else {
      pdf
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(C.muted)
        .text('No GST has been charged', tX, y, { width: tW });
      y += 17;
    }
    if (doc.paidCents > 0) row('Paid', money(-doc.paidCents), { muted: true, size: 8.5 });
    y += 2;
    pdf.rect(tX, y, tW, 1.6).fill(C.plum);
    y += 9;
    pdf.font('Helvetica-Bold').fontSize(12.5).fillColor(C.plum);
    pdf.text('Amount due', tX, y, { lineBreak: false });
    pdf.text(money(doc.dueCents), tX, y, { width: tW, align: 'right' });
    y += 34;

    // ── How to pay ──
    if (doc.pay) {
      pdf.font('Helvetica').fontSize(9.5);
      const heights = doc.pay.rows.map(([, value]) =>
        Math.max(15, pdf.heightOfString(value, { width: width - 130 }) + 4),
      );
      const panelH = 36 + heights.reduce((sum, height) => sum + height, 0);
      ensureSpace(panelH + 20);
      pdf.rect(left, y, width, panelH).fill(C.panel);
      pdf.rect(left, y, 2.4, panelH).fill(C.teal);
      pdf
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(C.plum)
        .text('How to pay', left + 14, y + 11);
      let py = y + 28;
      for (const [index, [label, value]] of doc.pay.rows.entries()) {
        pdf
          .font('Helvetica')
          .fontSize(9.5)
          .fillColor(C.muted)
          .text(label, left + 14, py, { lineBreak: false });
        pdf.fillColor(C.text).text(value, left + 110, py, { width: width - 130 });
        py += heights[index];
      }
      y += panelH + 20;
    }

    // ── Footnote ──
    if (doc.footnote) {
      pdf.font('Helvetica').fontSize(8.5);
      ensureSpace(pdf.heightOfString(doc.footnote, { width }) + 4);
      pdf.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(doc.footnote, left, y, { width });
    }

    pdf.end();
  });
}

module.exports = { buildInvoiceDocument, renderInvoicePdf };
