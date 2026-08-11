'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

function parseOrigins(value) {
  return String(value || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const config = {
  port: Number(process.env.PORT || 4300),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY,
  appOrigins: parseOrigins(process.env.APP_ORIGIN),
  venueTimeoutMs: Math.max(1000, Number(process.env.VENUE_TIMEOUT_MS || 5000)),
};

function validateRuntimeConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push('SESSION_SECRET (at least 32 characters)');
  if (!config.encryptionKey) missing.push('ENCRYPTION_KEY');
  if (missing.length) {
    throw new Error(`Missing or invalid environment configuration: ${missing.join(', ')}`);
  }
}

module.exports = { config, validateRuntimeConfig };

