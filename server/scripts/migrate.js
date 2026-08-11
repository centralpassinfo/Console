'use strict';

const { validateRuntimeConfig } = require('../src/config');
const { migrate, pool } = require('../src/db');

async function run() {
  validateRuntimeConfig();
  await migrate();
  console.log('Console database is up to date.');
  await pool.end();
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

