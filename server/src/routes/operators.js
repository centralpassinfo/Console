'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param } = require('express-validator');
const { pool } = require('../db');
const { encryptSecret } = require('../crypto');
const { generateTotpSecret, otpauthUri } = require('../totp');
const { validateRequest } = require('../validation');
const { requireAuth, consumeTotp, requireCsrf, actorFrom } = require('../auth');
const { recordAudit } = require('../audit');

// Console operators. Every change here is confirmed with the acting operator's
// own authenticator code, so an unattended signed-in browser cannot add an
// account or lock someone out.
const router = express.Router();
router.use(requireAuth);

function publicOperator(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    active: row.active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

const confirmCode = body('confirmCode').matches(/^\d{6}$/).withMessage('Enter your current 6-digit authenticator code to confirm.');
const passwordField = (field) => body(field).isString().isLength({ min: 14, max: 200 }).withMessage('Use a password of at least 14 characters.');

async function confirmed(req, res) {
  if (await consumeTotp(req.session.user.id, req.body.confirmCode)) return true;
  res.status(403).json({ error: 'That authenticator code is incorrect or was already used. Wait for the next code.', fields: [{ field: 'confirmCode', message: 'Incorrect or already used.' }] });
  return false;
}

function newAuthenticator(email) {
  const secret = generateTotpSecret();
  return { secret, encrypted: encryptSecret(secret), setup: { secret, uri: otpauthUri({ secret, email }) } };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, active, last_login_at, created_at FROM console_users ORDER BY active DESC, name ASC'
    );
    return res.json({ operators: rows.map(publicOperator), currentId: req.session.user.id });
  } catch (error) { return next(error); }
});

router.post(
  '/',
  requireCsrf,
  [
    body('name').isString().trim().isLength({ min: 2, max: 120 }).withMessage('Enter the operator’s name.'),
    body('email').trim().toLowerCase().isEmail().withMessage('Enter a valid email address.'),
    passwordField('password'),
    confirmCode,
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      if (!await confirmed(req, res)) return undefined;
      const authenticator = newAuthenticator(req.body.email);
      const { rows: [operator] } = await pool.query(
        `INSERT INTO console_users (email, name, password_hash, totp_secret)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, active, last_login_at, created_at`,
        [req.body.email, req.body.name, await bcrypt.hash(req.body.password, 12), authenticator.encrypted]
      );
      await recordAudit({ actor: actorFrom(req), action: 'operator.created', detail: { operatorId: operator.id, email: operator.email, name: operator.name } });
      // The secret is returned once, for the new operator's authenticator app.
      return res.status(201).json({ operator: publicOperator(operator), authenticator: authenticator.setup });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An operator with that email already exists.' });
      return next(error);
    }
  }
);

router.put(
  '/:id/active',
  requireCsrf,
  [param('id').isInt({ min: 1 }).toInt(), body('active').isBoolean().withMessage('Choose active or inactive.'), confirmCode],
  validateRequest,
  async (req, res, next) => {
    const db = await pool.connect();
    try {
      const active = req.body.active === true || req.body.active === 'true';
      if (!active && req.params.id === req.session.user.id) {
        return res.status(409).json({ error: 'You cannot deactivate your own account. Ask another operator.' });
      }
      if (!await confirmed(req, res)) return undefined;
      await db.query('BEGIN');
      // Serialise deactivations so two operators cannot remove the last two.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('console_operator_active'))");
      if (!active) {
        const { rows: [{ others }] } = await db.query(
          'SELECT COUNT(*)::int AS others FROM console_users WHERE active AND id <> $1',
          [req.params.id]
        );
        if (!others) {
          await db.query('ROLLBACK');
          return res.status(409).json({ error: 'Console needs at least one active operator.' });
        }
      }
      const { rows: [operator] } = await db.query(
        `UPDATE console_users
            SET active = $2, updated_at = NOW(),
                session_epoch = CASE WHEN $2 THEN session_epoch ELSE session_epoch + 1 END
          WHERE id = $1
          RETURNING id, email, name, active, last_login_at, created_at`,
        [req.params.id, active]
      );
      if (!operator) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Operator not found.' });
      }
      await recordAudit({ actor: actorFrom(req), action: active ? 'operator.reactivated' : 'operator.deactivated', detail: { operatorId: operator.id, email: operator.email, name: operator.name } }, db);
      await db.query('COMMIT');
      return res.json({ operator: publicOperator(operator) });
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally { db.release(); }
  }
);

router.post(
  '/:id/reset',
  requireCsrf,
  [
    param('id').isInt({ min: 1 }).toInt(),
    body('password').optional({ values: 'falsy' }).isString().isLength({ min: 14, max: 200 }).withMessage('Use a password of at least 14 characters.'),
    body('authenticator').optional().isBoolean(),
    body().custom((value) => {
      if (!value.password && value.authenticator !== true) throw new Error('Choose a new password, a new authenticator, or both.');
      return true;
    }),
    confirmCode,
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      if (!await confirmed(req, res)) return undefined;
      const { rows: [existing] } = await pool.query('SELECT id, email FROM console_users WHERE id = $1', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Operator not found.' });
      const authenticator = req.body.authenticator === true ? newAuthenticator(existing.email) : null;
      const passwordHash = req.body.password ? await bcrypt.hash(req.body.password, 12) : null;
      // Ending the operator's sessions is the point of a reset, including the
      // acting operator's own when they reset themselves.
      const { rows: [operator] } = await pool.query(
        `UPDATE console_users
            SET password_hash = COALESCE($2, password_hash),
                totp_secret = COALESCE($3, totp_secret),
                totp_last_step = CASE WHEN $3::text IS NULL THEN totp_last_step ELSE NULL END,
                session_epoch = session_epoch + 1,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, email, name, active, last_login_at, created_at`,
        [req.params.id, passwordHash, authenticator?.encrypted || null]
      );
      await recordAudit({
        actor: actorFrom(req),
        action: 'operator.reset',
        detail: { operatorId: operator.id, email: operator.email, password: Boolean(passwordHash), authenticator: Boolean(authenticator) },
      });
      return res.json({ operator: publicOperator(operator), authenticator: authenticator?.setup || null, signedOut: operator.id === req.session.user.id });
    } catch (error) { return next(error); }
  }
);

module.exports = router;
