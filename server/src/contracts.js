'use strict';

const CONTRACT_STATUSES = ['draft', 'sent', 'signed', 'expired', 'terminated'];
const EXPIRY_WARNING_DAYS = 60;

function parseMoneyToCents(value, label = 'Amount') {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label} must be a positive amount with no more than two decimal places.`);
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents > 1000000000) throw new Error(`${label} is too large.`);
  return cents;
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function publicContract(row) {
  return {
    id: row.id,
    venueId: row.venue_id,
    title: row.title,
    status: row.status,
    state: contractState(row),
    effectiveDate: dateOnly(row.effective_date),
    expiryDate: dateOnly(row.expiry_date),
    signedAt: dateOnly(row.signed_at),
    setupFeeCents: row.setup_fee_cents,
    monthlyFeeCents: row.monthly_fee_cents,
    autoRenews: row.auto_renews,
    noticePeriodDays: row.notice_period_days,
    notes: row.notes,
    fileName: row.original_filename,
    fileSizeBytes: row.file_size_bytes,
    sha256: row.file_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contractState(contract, today = new Date()) {
  if (!contract) return 'missing';
  if (contract.status === 'terminated') return 'terminated';
  if (contract.status === 'expired') return 'expired';
  if (contract.status !== 'signed') return contract.status;
  const expiry = dateOnly(contract.expiry_date || contract.expiryDate);
  if (!expiry) return 'active';
  const todayText = dateOnly(today);
  if (expiry < todayText) return 'expired';
  const warningDate = new Date(`${todayText}T00:00:00Z`);
  warningDate.setUTCDate(warningDate.getUTCDate() + EXPIRY_WARNING_DAYS);
  return expiry <= dateOnly(warningDate) ? 'expiring' : 'active';
}

function summarizeContracts(rows, today = new Date()) {
  if (!rows?.length) return { state: 'missing', count: 0, nextExpiry: null };
  const contracts = rows.map((row) => ({ row, state: contractState(row, today) }));
  const priority = ['expiring', 'active', 'sent', 'draft', 'expired', 'terminated'];
  const selectedState = priority.find((state) => contracts.some((item) => item.state === state)) || 'missing';
  const activeExpiries = contracts
    .filter((item) => ['active', 'expiring'].includes(item.state))
    .map((item) => dateOnly(item.row.expiry_date || item.row.expiryDate))
    .filter(Boolean)
    .sort();
  return {
    state: selectedState,
    count: rows.length,
    nextExpiry: activeExpiries[0] || null,
  };
}

module.exports = {
  CONTRACT_STATUSES,
  EXPIRY_WARNING_DAYS,
  parseMoneyToCents,
  dateOnly,
  publicContract,
  contractState,
  summarizeContracts,
};
