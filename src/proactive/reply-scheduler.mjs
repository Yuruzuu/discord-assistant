import { setTimeout as wait } from 'node:timers/promises';
import { createConcurrencyLimit } from '../concurrency.mjs';

export function createReplyScheduler({ cooldownMs = 5000, maxRepliesPerMinute = 6, now = Date.now, sleep = wait } = {}) {
  const serialize = createConcurrencyLimit(1);
  const attempts = [];
  let lastCompleted = -Infinity;

  return (operation, signal) => serialize(async () => {
    signal?.throwIfAborted();
    while (true) {
      const timestamp = now();
      while (attempts[0] <= timestamp - 60000) attempts.shift();
      const delay = Math.max(cooldownMs - (timestamp - lastCompleted), attempts.length >= maxRepliesPerMinute ? attempts[0] + 60000 - timestamp : 0);
      if (delay <= 0) break;
      await sleep(delay, undefined, signal ? { signal } : undefined);
      signal?.throwIfAborted();
    }
    attempts.push(now());
    try { return await operation(); }
    finally { lastCompleted = now(); }
  });
}
