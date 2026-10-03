import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { DiscordApiClient } from '../src/discord-api.mjs';
import { startTypingIndicator } from '../src/proactive/typing.mjs';

async function until(condition) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await setTimeout(5);
  assert.ok(condition(), 'Expected typing update did not arrive');
}

test('typing starts immediately, renews during work and stops after completion', async () => {
  let calls = 0;
  const stop = startTypingIndicator(async () => { calls += 1; }, { intervalMs: 5 });
  try {
    assert.equal(calls, 1);
    await until(() => calls >= 3);
    stop();
    const completed = calls;
    await setTimeout(20);
    assert.equal(calls, completed);
  } finally { stop(); }
});

test('typing pulses do not overlap and cancellation aborts a pending request', async () => {
  const cancellation = new AbortController();
  let calls = 0;
  let requestSignal;
  let aborted = false;
  const stop = startTypingIndicator((signal) => new Promise((resolve, reject) => {
    calls += 1;
    requestSignal = signal;
    signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
  }), { signal: cancellation.signal, intervalMs: 5 });
  try {
    await setTimeout(20);
    assert.equal(calls, 1);
    cancellation.abort();
    await setTimeout(20);
    assert.equal(aborted, true);
    assert.equal(requestSignal.aborted, true);
    assert.equal(calls, 1);
  } finally { stop(); }
});

test('a stopped listener emits no typing and transient typing errors can recover', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  let calls = 0;
  startTypingIndicator(async () => { calls += 1; }, { signal: cancelled.signal });
  assert.equal(calls, 0);
  const stop = startTypingIndicator(async () => { if (++calls === 1) throw new Error('Typing unavailable'); }, { intervalMs: 5 });
  try { await until(() => calls >= 2); }
  finally { stop(); }
});

test('typing uses the bot REST endpoint with no message payload and accepts HTTP 204', async () => {
  let request;
  const client = new DiscordApiClient({ accountId: 'reader', token: 'mock-token', fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  } });
  assert.equal(await client.triggerTyping('200000000000000001'), null);
  assert.equal(new URL(request.url).pathname, '/api/v10/channels/200000000000000001/typing');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body, undefined);
});
