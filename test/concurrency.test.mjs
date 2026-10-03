import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createConcurrencyLimit, mapConcurrent } from '../src/concurrency.mjs';

test('limits concurrent operations and releases slots after rejection', async () => {
  const run = createConcurrencyLimit(2);
  let active = 0;
  let maximumActive = 0;
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => run(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await setTimeout(5);
    active -= 1;
    if (index === 1) throw new Error('Expected failure');
    return index;
  })));

  assert.equal(maximumActive, 2);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(await run(() => 42), 42);
});

test('concurrent mapping preserves input order when requests finish out of order', async () => {
  const results = await mapConcurrent([20, 10, 0], 3, async (delay) => {
    await setTimeout(delay);
    return delay;
  });

  assert.deepEqual(results, [20, 10, 0]);
});

test('stops starting queued work after an error and drains active workers', async () => {
  const started = [];
  const completed = [];
  await assert.rejects(() => mapConcurrent([0, 1, 2, 3], 2, async (index) => {
    started.push(index);
    if (index === 0) throw new Error('Expected failure');
    await setTimeout(5);
    completed.push(index);
  }), /Expected failure/);

  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(completed, [1]);
});
