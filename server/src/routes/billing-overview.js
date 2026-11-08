'use strict';
const express = require('express');
const { requireAuth, requireCsrf, actorFrom } = require('../auth');
const { handleRoute: handle } = require('./billing-documents');
const billing = require('../billing-service');
const router = express.Router();
router.use(requireAuth);
router.get(
  '/',
  handle(async (req, res) => res.json(await billing.overview())),
);
router.get(
  '/settings',
  handle(async (req, res) =>
    res.json({
      settings: await billing.settings(),
      emailReady: require('../brevo').emailConfigured(),
    }),
  ),
);
router.put(
  '/settings',
  requireCsrf,
  handle(async (req, res) =>
    res.json({ settings: await billing.updateSettings(req.body, actorFrom(req)) }),
  ),
);
router.get(
  '/run-preview',
  handle(async (req, res) => res.json(await billing.preview(req.query.date))),
);
router.post(
  '/run',
  requireCsrf,
  handle(async (req, res) => res.json(await billing.run({ actor: actorFrom(req), manual: true }))),
);
module.exports = router;
