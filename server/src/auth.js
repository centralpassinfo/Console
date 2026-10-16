'use strict';

const crypto = require('crypto');
const { pool } = require('./db');
const { decryptSecret } = require('./crypto');
const { matchTotpStep } = require('./totp');

// A session is only as good as the operator behind it. Every request rechecks
// that the operator still exists, is active, and has not had their sessions
// ended by a deactivation or a password or authenticator reset since.
async function requireAuth(req, res, next) {
  const sessionUser = req.session?.user;
  if (!sessionUser) return res.status(401).json({ error: 'Sign in required.' });
  try {
    const { rows: [user] } = await pool.query(
      'SELECT active, session_epoch FROM console_users WHERE id = $1',
      [sessionUser.id]
    );
    if (!user || !user.active || user.session_epoch !== (sessionUser.epoch ?? 0)) {
      req.session.destroy?.(() => {});
      return res.status(401).json({ error: 'Your session has ended. Sign in again.', code: 'SESSION_ENDED' });
    }
    return next();
  } catch (error) { return next(error); }
}

/**
 * Accept an operator's authenticator code once. The step it belongs to is
 * recorded atomically, so a code that was already used (to sign in or to
 * confirm a change) is refused, even within its 90-second window.
 */
async function consumeTotp(userId, code, db = pool) {
  const { rows: [user] } = await db.query(
    'SELECT totp_secret FROM console_users WHERE id = $1 AND active',
    [userId]
  );
  if (!user) return false;
  let step = null;
  try { step = matchTotpStep(decryptSecret(user.totp_secret), code); } catch { step = null; }
  if (step === null) return false;
  const { rowCount } = await db.query(
    `UPDATE console_users SET totp_last_step = $2
      WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
    [userId, step]
  );
  return rowCount === 1;
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

module.exports = { requireAuth, consumeTotp, ensureCsrfToken, requireCsrf, actorFrom };
