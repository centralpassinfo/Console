'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  concurrencyLimit,
  runLimited,
  runWorkerQueue,
} = require('../src/release-concurrency');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('worker concurrency settings are bounded and reject invalid values', () => {
  assert.equal(concurrencyLimit(undefined, 3, 5), 3);
  assert.equal(concurrencyLimit('1', 3, 5), 1);
  for (const value of ['bad', 0, -1, 1.5, 6])
    assert.throws(() => concurrencyLimit(value, 3, 5), /integer between/);
});

test('portal concurrency stops new uploads on failure and drains uploads already running', async () => {
  const running = deferred(),
    finish = deferred();
  const started = [];
  let settled = false;
  const work = runLimited(
    [
      async () => {
        started.push('admin');
        await running.promise;
        throw new Error('Admin build failed');
      },
      async () => {
        started.push('staff');
        running.resolve();
        await finish.promise;
      },
      async () => {
        started.push('employee');
      },
    ],
    2,
  );
  const outcome = work.then(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await running.promise;
  await tick();
  assert.deepEqual(started, ['admin', 'staff']);
  assert.equal(settled, false);
  finish.resolve();
  assert.match((await outcome).message, /Admin build failed/);
  assert.deepEqual(
    started,
    ['admin', 'staff'],
    'Unstarted portals stay untouched after failure.',
  );
});

test('venue slots run concurrently and refill without waiting for the slowest venue', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const began = [deferred(), deferred(), deferred(), deferred()];
  const jobs = [1, 2, 3, 4];
  const started = [];
  let stop = false,
    active = 0,
    maxActive = 0,
    done = false;
  const work = runWorkerQueue({
    concurrency: 2,
    claim: async () => jobs.shift(),
    shouldStop: () => stop,
    wait: () => new Promise(() => {}),
    processJob: async (id) => {
      started.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      began[id - 1].resolve();
      await gates[id - 1].promise;
      active--;
    },
  }).then(() => {
    done = true;
  });
  await began[1].promise;
  assert.deepEqual(started, [1, 2]);
  gates[0].resolve();
  await began[2].promise;
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(maxActive, 2);
  stop = true;
  gates[1].resolve();
  await tick();
  assert.equal(done, false, 'Shutdown must wait for every active lease.');
  gates[2].resolve();
  await work;
  assert.equal(active, 0);
  assert.deepEqual(jobs, [4]);
});

test('unexpected venue errors drain other leases and stop new claims', async () => {
  const bothStarted = deferred(),
    finish = deferred();
  const started = [];
  let settled = false;
  const jobs = [1, 2, 3];
  const work = runWorkerQueue({
    concurrency: 2,
    claim: async () => jobs.shift(),
    wait: () => new Promise(() => {}),
    processJob: async (id) => {
      started.push(id);
      if (id === 2) bothStarted.resolve();
      await bothStarted.promise;
      if (id === 1) throw new Error('Database unavailable');
      await finish.promise;
    },
  });
  const outcome = work.then(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await bothStarted.promise;
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(started, [1, 2]);
  finish.resolve();
  assert.match((await outcome).message, /Database unavailable/);
  assert.deepEqual(jobs, [3]);
});

test('a lease claimed during shutdown still finishes', async () => {
  const claiming = deferred(),
    releaseClaim = deferred();
  let stop = false,
    processed = false;
  const work = runWorkerQueue({
    concurrency: 1,
    shouldStop: () => stop,
    claim: async () => {
      claiming.resolve();
      await releaseClaim.promise;
      return { id: 1 };
    },
    processJob: async () => {
      processed = true;
    },
  });
  await claiming.promise;
  stop = true;
  releaseClaim.resolve();
  await work;
  assert.equal(processed, true);
});
