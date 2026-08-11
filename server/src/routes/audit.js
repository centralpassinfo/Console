'use strict';

const express = require('express');
const { query } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { validateRequest } = require('../validation');

const router = express.Router();

router.get(
  '/',
  requireAuth,
  [query('limit').optional().isInt({ min: 1, max: 200 }).toInt()],
  validateRequest,
  async (req, res, next) => {
    try {
      const limit = req.query.limit || 100;
      const { rows } = await pool.query(
        `SELECT a.id, a.venue_id, v.name AS venue_name, a.actor, a.action, a.detail, a.created_at
           FROM console_audit a
           LEFT JOIN venues v ON v.id = a.venue_id
          ORDER BY a.created_at DESC
          LIMIT $1`,
        [limit]
      );
      return res.json({ audit: rows });
    } catch (error) { return next(error); }
  }
);

module.exports = router;

