'use strict';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function concurrencyLimit(value, fallback, max) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error(
      `Release concurrency must be an integer between 1 and ${max}.`,
    );
  return n;
}

// Stop scheduling on failure, but drain every upload/verification already in
// progress before removing the shared source directory or marking the job done.
async function runLimited(tasks, concurrency) {
  let next = 0,
    failed = false,
    failure;
  const results = new Array(tasks.length);
  async function consume() {
    while (!failed && next < tasks.length) {
      const index = next++;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, consume),
  );
  if (failed) throw failure;
  return results;
}

// Each claim is an atomic Postgres lease. Slots refill as individual venues
// finish; a slow venue does not hold up every other venue or discovery polling.
async function runWorkerQueue({
  claim,
  processJob,
  reconcile = async () => {},
  shouldStop = () => false,
  concurrency = 3,
  idleMs = 3000,
  wait = sleep,
}) {
  const active = new Set();
  let fatal;
  function start(job) {
    const task = Promise.resolve()
      .then(() => processJob(job))
      .catch((error) => {
        fatal ||= error;
      })
      .finally(() => active.delete(task));
    active.add(task);
  }
  try {
    while (!shouldStop() && !fatal) {
      while (active.size < concurrency && !shouldStop() && !fatal) {
        const job = await claim();
        if (!job) break;
        // Even if shutdown arrived during claim(), finish the claimed lease.
        start(job);
      }
      if (shouldStop() || fatal) break;
      await reconcile();
      await Promise.race([wait(idleMs), ...active]);
    }
  } finally {
    await Promise.allSettled([...active]);
  }
  if (fatal) throw fatal;
}
module.exports = { concurrencyLimit, runLimited, runWorkerQueue };
