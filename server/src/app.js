'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const { pool } = require('./db');
const { config } = require('./config');

const app = express();
const PgSession = connectPgSimple(session);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use(express.json({ limit: '100kb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'console_sessions', createTableIfMissing: true }),
  name: 'centralpass.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.nodeEnv === 'production',
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('Origin');
  if (!origin || config.appOrigins.includes(origin.replace(/\/$/, ''))) return next();
  return res.status(403).json({ error: 'Request origin is not allowed.' });
});

app.get('/api/console/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', service: 'centralpass-console', database: 'ok' });
  } catch {
    return res.status(503).json({ status: 'degraded', service: 'centralpass-console', database: 'unavailable' });
  }
});
app.use('/api/console/auth', require('./routes/auth'));
app.use('/api/console/venues', require('./routes/venues'));
app.use('/api/console/venues', require('./routes/contracts'));
app.use('/api/console/audit', require('./routes/audit'));

if (config.nodeEnv === 'production') {
  const dist = path.resolve(__dirname, '../../dist');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'The console could not complete that request.' });
});

module.exports = app;
