'use strict';

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const { config } = require('./config');

// A DATE column is a calendar day, not an instant. pg's default turns it into a
// Date at local midnight, which shifts it by a day once serialised from any
// host east of UTC. Keep it as the YYYY-MM-DD text Postgres stored.
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  idleTimeoutMillis: 30000,
});

async function migrate() {
  const migrationsDir = path.resolve(__dirname, '../migrations');
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
  }
}

module.exports = { pool, migrate };

