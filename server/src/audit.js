'use strict';

const { pool } = require('./db');

async function recordAudit({ venueId = null, actor, action, detail = {} }, db = pool) {
  const { rows: [row] } = await db.query(
    `INSERT INTO console_audit (venue_id, actor, action, detail)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [venueId, actor, action, JSON.stringify(detail)]
  );
  return row.id;
}

async function completeAudit(id, detail, db = pool) {
  await db.query(
    `UPDATE console_audit
        SET detail = COALESCE(detail, '{}'::jsonb) || $2::jsonb
      WHERE id = $1`,
    [id, JSON.stringify(detail)]
  );
}

module.exports = { recordAudit, completeAudit };

