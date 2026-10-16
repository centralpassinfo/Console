'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const { pool } = require('../db');
const { validateRequest } = require('../validation');
const { requireAuth, consumeTotp, ensureCsrfToken, requireCsrf, actorFrom } = require('../auth');
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
    // Accounts are stored trimmed and lower-cased. normalizeEmail() would also
    // strip dots from Gmail addresses, so such an operator could never sign in.
    body('email').trim().toLowerCase().isEmail().withMessage('Enter a valid email address.'),
    body('password').isString().isLength({ min: 12, max: 200 }).withMessage('Enter your password.'),
    body('totpCode').matches(/^\d{6}$/).withMessage('Enter the 6-digit authenticator code.'),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const { rows: [user] } = await pool.query(
        `SELECT id, email, name, password_hash, active, session_epoch
           FROM console_users
          WHERE email = $1`,
        [req.body.email]
      );

      const passwordMatches = user
        ? await bcrypt.compare(req.body.password, user.password_hash)
        : await bcrypt.compare(req.body.password, await bcrypt.hash('invalid-login-attempt', 12));
      // A code already used to sign in or confirm a change is refused.
      const totpMatches = Boolean(user?.active && passwordMatches && await consumeTotp(user.id, req.body.totpCode));

      if (!user || !user.active || !passwordMatches || !totpMatches) {
        return res.status(401).json({ error: 'Email, password or authenticator code is incorrect.' });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate((error) => (error ? reject(error) : resolve()));
      });
      req.session.user = { id: user.id, email: user.email, name: user.name, epoch: user.session_epoch };
      const csrfToken = ensureCsrfToken(req);
      await pool.query(`UPDATE console_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
      await recordAudit({ actor: user.name || user.email, action: 'auth.login', detail: { email: user.email } });
      return res.json({ user: { id: user.id, email: user.email, name: user.name }, csrfToken });
    } catch (error) { return next(error); }
  }
);

router.get('/me', async (req, res, next) => {
  try {
    if (!req.session?.user) return res.json({ user: null });
    const { rows: [user] } = await pool.query(
      'SELECT active, session_epoch FROM console_users WHERE id = $1',
      [req.session.user.id]
    );
    if (!user || !user.active || user.session_epoch !== (req.session.user.epoch ?? 0)) {
      req.session.destroy(() => {});
      return res.json({ user: null });
    }
    const { epoch, ...publicUser } = req.session.user;
    return res.json({ user: publicUser, csrfToken: ensureCsrfToken(req) });
  } catch (error) { return next(error); }
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
