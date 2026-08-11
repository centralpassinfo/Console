'use strict';

const { validationResult } = require('express-validator');

function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Please check the submitted fields.',
      fields: errors.array().map(({ path, msg }) => ({ field: path, message: msg })),
    });
  }
  next();
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { validateRequest, isHttpUrl };

