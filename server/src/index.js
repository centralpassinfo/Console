'use strict';

const { validateRuntimeConfig, config } = require('./config');
const { migrate, pool } = require('./db');

async function start() {
  validateRuntimeConfig();
  await migrate();
  const app = require('./app');
  const server = app.listen(config.port, () => {
    console.log(`CentralPass Console listening on port ${config.port}`);
  });
  const stopBilling = require('./billing-worker').startBillingWorker();

  async function shutdown(signal) {
    console.log(`${signal} received, closing CentralPass Console`);
    server.close(async () => {
      await stopBilling();
      await pool.end();
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('CentralPass Console failed to start:', error.message);
  process.exit(1);
});

