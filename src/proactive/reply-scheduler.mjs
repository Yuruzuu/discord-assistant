import { setTimeout as wait } from 'node:timers/promises';

export function createReplyScheduler({ cooldownMs = 5000, maxRepliesPerMinute = 6, maxConcurrent = 2, maxQueued = 100, now = Date.now, sleep = wait } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 1 || !Number.isSafeInteger(maxRepliesPerMinute) || maxRepliesPerMinute < 1 || !Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error('Invalid reply scheduler limits');
  const pending = [];
  const activeKeys = new Set();
  const completed = new Map();
  const attempts = [];
  let active = 0;
  let waking;

  function wake() { waking?.abort(); waking = undefined; }

  function pump() {
    wake();
    const timestamp = now();
    while (attempts.length && attempts[0] <= timestamp - 60000) attempts.shift();
    for (const [key, time] of completed) if (timestamp - time >= cooldownMs) completed.delete(key);
    let delay = Infinity;
    while (active < maxConcurrent && pending.length) {
      const rateDelay = attempts.length >= maxRepliesPerMinute ? attempts[0] + 60000 - timestamp : 0;
      const index = pending.findIndex((job) => !activeKeys.has(job.key) && timestamp - (completed.get(job.key) ?? -Infinity) >= cooldownMs);
      if (index < 0) {
        for (const job of pending) if (!activeKeys.has(job.key)) delay = Math.min(delay, cooldownMs - (timestamp - completed.get(job.key)));
        if (Number.isFinite(delay)) delay = Math.max(delay, rateDelay);
        break;
      }
      if (rateDelay > 0) { delay = rateDelay; break; }
      const job = pending.splice(index, 1)[0];
      job.signal?.removeEventListener('abort', job.cancel);
      if (job.signal?.aborted) { job.reject(job.signal.reason); continue; }
      attempts.push(timestamp);
      active += 1;
      activeKeys.add(job.key);
      // Admission records actual model starts, never enqueue timestamps.
      Promise.resolve().then(() => {
        job.signal?.throwIfAborted();
        try { job.onWait?.(Math.max(0, now() - job.enqueuedAt)); } catch {}
        return job.operation();
      }).then(job.resolve, job.reject).finally(() => {
        active -= 1;
        activeKeys.delete(job.key);
        completed.set(job.key, now());
        pump();
      });
    }
    if (Number.isFinite(delay) && pending.length && active < maxConcurrent) {
      const cancellation = new AbortController();
      waking = cancellation;
      Promise.resolve().then(() => { cancellation.signal.throwIfAborted(); return sleep(Math.max(1, delay), undefined, { signal: cancellation.signal }); }).then(() => {
        if (waking === cancellation) { waking = undefined; pump(); }
      }, (error) => {
        if (cancellation.signal.aborted || waking !== cancellation) return;
        waking = undefined;
        for (const job of pending.splice(0)) { job.signal?.removeEventListener('abort', job.cancel); job.reject(error); }
      });
    }
  }

  return (operation, signal, { conversationKey = 'default', onWait } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    if (pending.length >= maxQueued) { reject(new Error('Nova reply queue is full')); return; }
    const job = { operation, signal, key: String(conversationKey), onWait, enqueuedAt: now(), resolve, reject };
    job.cancel = () => { const index = pending.indexOf(job); if (index < 0) return; pending.splice(index, 1); signal.removeEventListener('abort', job.cancel); reject(signal.reason); pump(); };
    pending.push(job);
    signal?.addEventListener('abort', job.cancel, { once: true });
    pump();
  });
}
