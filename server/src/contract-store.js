'use strict';

const { pool } = require('./db');
const { publicContract, summarizeContracts } = require('./contracts');

const METADATA_COLUMNS = `
  id, venue_id, title, status, effective_date, expiry_date, signed_at,
  setup_fee_cents, monthly_fee_cents, auto_renews, notice_period_days, notes,
  original_filename, file_size_bytes, file_sha256, created_by, created_at, updated_at
`;

async function listVenueContracts(venueId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${METADATA_COLUMNS}
       FROM venue_contracts
      WHERE venue_id = $1
      ORDER BY created_at DESC, id DESC`,
    [venueId]
  );
  return rows.map(publicContract);
}

async function contractSummaries(venueIds, db = pool) {
  const ids = venueIds.map(Number).filter(Number.isInteger);
  const summaries = new Map();
  if (!ids.length) return summaries;
  const { rows } = await db.query(
    `SELECT ${METADATA_COLUMNS}
       FROM venue_contracts
      WHERE venue_id = ANY($1::int[])
      ORDER BY created_at DESC, id DESC`,
    [ids]
  );
  for (const venueId of ids) {
    summaries.set(venueId, summarizeContracts(rows.filter((row) => row.venue_id === venueId)));
  }
  return summaries;
}

module.exports = { METADATA_COLUMNS, listVenueContracts, contractSummaries };
