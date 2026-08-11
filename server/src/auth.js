'use strict';

const crypto = require('crypto');

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const expected = req.session?.csrfToken;
  const presented = req.get('X-CSRF-Token');
  if (!expected || !presented || expected.length !== presented.length) {
    return res.status(403).json({ error: 'The security token is missing or expired. Refresh and try again.' });
  }
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presented))) {
    return res.status(403).json({ error: 'The security token is invalid. Refresh and try again.' });
  }
  next();
}

function actorFrom(req) {
  return req.session.user.name || req.session.user.email;
}

module.exports = { requireAuth, ensureCsrfToken, requireCsrf, actorFrom };

