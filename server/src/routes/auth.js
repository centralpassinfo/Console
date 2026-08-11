'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const { pool } = require('../db');
const { decryptSecret } = require('../crypto');
const { verifyTotp } = require('../totp');
const { validateRequest } = require('../validation');
const { requireAuth, ensureCsrfToken, requireCsrf, actorFrom } = require('../auth');
const { recordAudit } = require('../audit');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' },
});

router.post(
  '/login',
  loginLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Enter a valid email address.'),
    body('password').isString().isLength({ min: 12, max: 200 }).withMessage('Enter your password.'),
    body('totpCode').matches(/^\d{6}$/).withMessage('Enter the 6-digit authenticator code.'),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const { rows: [user] } = await pool.query(
        `SELECT id, email, name, password_hash, totp_secret, active
           FROM console_users
          WHERE email = $1`,
        [req.body.email]
      );

      const passwordMatches = user
        ? await bcrypt.compare(req.body.password, user.password_hash)
        : await bcrypt.compare(req.body.password, await bcrypt.hash('invalid-login-attempt', 12));
      let totpMatches = false;
      if (user && passwordMatches) {
        try { totpMatches = verifyTotp(decryptSecret(user.totp_secret), req.body.totpCode); } catch { totpMatches = false; }
      }

      if (!user || !user.active || !passwordMatches || !totpMatches) {
        return res.status(401).json({ error: 'Email, password or authenticator code is incorrect.' });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate((error) => (error ? reject(error) : resolve()));
      });
      req.session.user = { id: user.id, email: user.email, name: user.name };
      const csrfToken = ensureCsrfToken(req);
      await pool.query(`UPDATE console_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
      await recordAudit({ actor: user.name || user.email, action: 'auth.login', detail: { email: user.email } });
      return res.json({ user: req.session.user, csrfToken });
    } catch (error) { return next(error); }
  }
);

router.get('/me', async (req, res) => {
  if (!req.session?.user) return res.json({ user: null });
  return res.json({ user: req.session.user, csrfToken: ensureCsrfToken(req) });
});

router.post('/logout', requireAuth, requireCsrf, async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    await recordAudit({ actor, action: 'auth.logout' });
    await new Promise((resolve, reject) => {
      req.session.destroy((error) => (error ? reject(error) : resolve()));
    });
    res.clearCookie('centralpass.sid');
    return res.status(204).end();
  } catch (error) { return next(error); }
});

module.exports = router;
