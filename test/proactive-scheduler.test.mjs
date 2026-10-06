import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createReplyScheduler } from '../src/proactive/reply-scheduler.mjs';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => wait(0);

test('separate conversations run in parallel while one lane stays ordered and waiting lanes do not starve others', async () => {
  const schedule = createReplyScheduler({ cooldownMs: 0, maxRepliesPerMinute: 100 });
  const first = deferred();
  const second = deferred();
  const starts = [];
  const one = schedule(async () => { starts.push('a1'); await first.promise; }, undefined, { conversationKey: 'a' });
  const two = schedule(async () => { starts.push('a2'); }, undefined, { conversationKey: 'a' });
  const three = schedule(async () => { starts.push('b'); await second.promise; }, undefined, { conversationKey: 'b' });
  const four = schedule(async () => { starts.push('c'); }, undefined, { conversationKey: 'c' });
  await tick();
  assert.deepEqual(starts, ['a1', 'b']);
  second.resolve();
  await tick();
  assert.deepEqual(starts, ['a1', 'b', 'c'], 'a queued turn cannot block another free lane');
  first.resolve();
  await Promise.all([one, two, three, four]);
  assert.deepEqual(starts, ['a1', 'b', 'c', 'a2']);
});

test('a cooling conversation does not impose its post-completion cooldown on another channel', async () => {
  const schedule = createReplyScheduler({ cooldownMs: 40, maxRepliesPerMinute: 100 });
  await schedule(async () => {}, undefined, { conversationKey: 'a' });
  const starts = [];
  const cooling = schedule(async () => { starts.push('a'); }, undefined, { conversationKey: 'a' });
  const other = schedule(async () => { starts.push('b'); }, undefined, { conversationKey: 'b' });
  await other;
  assert.deepEqual(starts, ['b']);
  await cooling;
  assert.deepEqual(starts, ['b', 'a']);
});

test('cancelled queued work consumes neither concurrency nor rate attempts and detaches its abort listener', async () => {
  const schedule = createReplyScheduler({ cooldownMs: 0, maxConcurrent: 1, maxRepliesPerMinute: 2 });
  const active = deferred();
  const first = schedule(() => active.promise, undefined, { conversationKey: 'a' });
  const cancellation = new AbortController();
  let cancelledRan = false;
  const pending = schedule(async () => { cancelledRan = true; }, cancellation.signal, { conversationKey: 'b' });
  cancellation.abort();
  await assert.rejects(pending, /abort/i);
  const replacement = schedule(async () => 'admitted', undefined, { conversationKey: 'c' });
  active.resolve();
  await first;
  assert.equal(await replacement, 'admitted');
  assert.equal(cancelledRan, false);
});

test('shared attempts are limited at admission and queue backpressure is bounded', async () => {
  let clock = 0;
  const waits = [];
  const schedule = createReplyScheduler({ cooldownMs: 0, maxRepliesPerMinute: 2, now: () => clock, sleep: async (delay) => { waits.push(delay); clock += delay; } });
  const starts = [];
  await Promise.all(['a', 'b', 'c'].map((conversationKey) => schedule(async () => { starts.push(clock); }, undefined, { conversationKey })));
  assert.deepEqual(starts, [0, 0, 60000]);
  assert.deepEqual(waits, [60000]);
  const blocker = deferred();
  const bounded = createReplyScheduler({ maxConcurrent: 1, maxQueued: 1, cooldownMs: 0 });
  const active = bounded(() => blocker.promise);
  const queued = bounded(async () => {});
  await assert.rejects(bounded(async () => {}), /queue is full/);
  blocker.resolve();
  await Promise.all([active, queued]);
});

test('failed operations release their lane and callbacks observe actual queue wait', async () => {
  let clock = 100;
  const waits = [];
  const schedule = createReplyScheduler({ cooldownMs: 0, now: () => clock, maxConcurrent: 1 });
  const blocker = deferred();
  const first = schedule(async () => { await blocker.promise; throw new Error('Worker failed'); }, undefined, { conversationKey: 'a' });
  const second = schedule(async () => 'ok', undefined, { conversationKey: 'b', onWait: (elapsed) => waits.push(elapsed) });
  clock = 140;
  const rejected = assert.rejects(first, /Worker failed/);
  blocker.resolve();
  await rejected;
  assert.equal(await second, 'ok');
  assert.deepEqual(waits, [40]);
});
