'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return output;
}

function decodeBase32(value) {
  const cleaned = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('Invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotpSecret(bytes = 20) {
  return encodeBase32(crypto.randomBytes(bytes));
}

function totpAt(secret, timeMs = Date.now(), options = {}) {
  const period = options.period || 30;
  const digits = options.digits || 6;
  const counter = Math.floor(timeMs / 1000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function verifyTotp(secret, code, options = {}) {
  const candidate = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return false;
  const timeMs = options.timeMs || Date.now();
  const window = options.window ?? 1;
  for (let step = -window; step <= window; step += 1) {
    const expected = totpAt(secret, timeMs + step * 30000);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) return true;
  }
  return false;
}

function otpauthUri({ secret, email, issuer = 'CentralPass Console' }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { encodeBase32, decodeBase32, generateTotpSecret, totpAt, verifyTotp, otpauthUri };

