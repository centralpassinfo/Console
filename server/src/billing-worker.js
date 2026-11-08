'use strict';
// Every API instance may tick: the database advisory lock permits one run only.
function startBillingWorker({ run = require('./billing-service').run, intervalMs = 3600000 } = {}) {
  let running = null,
    stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = Promise.resolve()
      .then(() => run())
      .catch((error) =>
        console.error('Billing check failed:', error.code || 'See billing run status'),
      )
      .finally(() => {
        running = null;
      });
  };
  const initial = setTimeout(tick, 10000),
    timer = setInterval(tick, intervalMs);
  initial.unref?.();
  timer.unref?.();
  return async () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(timer);
    if (running) await running;
  };
}
module.exports = { startBillingWorker };
