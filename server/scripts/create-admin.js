'use strict';

const bcrypt = require('bcryptjs');
const { validateRuntimeConfig } = require('../src/config');
const { migrate, pool } = require('../src/db');
const { encryptSecret } = require('../src/crypto');
const { generateTotpSecret, otpauthUri } = require('../src/totp');

async function run() {
  validateRuntimeConfig();
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const name = String(process.env.ADMIN_NAME || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !email.includes('@')) throw new Error('Set ADMIN_EMAIL to a valid email address.');
  if (name.length < 2) throw new Error('Set ADMIN_NAME.');
  if (password.length < 14) throw new Error('Set ADMIN_PASSWORD to at least 14 characters.');

  await migrate();
  const existing = await pool.query(`SELECT id FROM console_users WHERE email = $1`, [email]);
  if (existing.rowCount) throw new Error('An account with that email already exists.');

  const secret = generateTotpSecret();
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO console_users (email, name, password_hash, totp_secret)
     VALUES ($1, $2, $3, $4)`,
    [email, name, passwordHash, encryptSecret(secret)]
  );

  console.log('\nCentralPass Console account created.');
  console.log('Add this account to your authenticator now. This secret is shown once.\n');
  console.log(`Account: ${email}`);
  console.log(`TOTP secret: ${secret}`);
  console.log(`Authenticator URI: ${otpauthUri({ secret, email })}\n`);
  console.log('Remove ADMIN_PASSWORD from the environment after confirming sign-in.');
  await pool.end();
}

run().catch(async (error) => {
  console.error(error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

