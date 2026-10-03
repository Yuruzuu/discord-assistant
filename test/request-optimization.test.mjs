import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { DiscordApiClient } from '../src/discord-api.mjs';

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function virtualTime() {
  let current = 0;
  const waits = [];

  return {
    waits,
    now: () => current,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      current += milliseconds;
    },
  };
}

test('overlapping identical requests use one fetch but later reads remain fresh', async () => {
  let calls = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    fetchImpl: async () => {
      const revision = ++calls;
      await setTimeout(5);
      return json({ revision });
    },
  });
  const results = await Promise.all([client.get('/test'), client.get('/test')]);

  assert.deepEqual(results, [{ revision: 1 }, { revision: 1 }]);
  assert.deepEqual(await client.get('/test'), { revision: 2 });
  assert.equal(calls, 2);
});

test('a failed request does not retain a rejected promise or hide permission changes', async () => {
  let calls = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    fetchImpl: async () => ++calls === 1 ? json({ message: 'Missing Access' }, 403) : json({ ok: true }),
  });
  const results = await Promise.allSettled([client.get('/test'), client.get('/test')]);

  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.deepEqual(await client.get('/test'), { ok: true });
  assert.equal(calls, 2);
});

test('bounds network concurrency across independent routes', async () => {
  let active = 0;
  let maximumActive = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    maxConcurrentRequests: 2,
    fetchImpl: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await setTimeout(5);
      active -= 1;
      return json({ ok: true });
    },
  });
  await Promise.all(Array.from({ length: 8 }, (_, index) => client.get(`/guilds/${100000000000000001n + BigInt(index)}`)));

  assert.equal(maximumActive, 2);
});

test('waits the full retry_after even when it exceeds thirty seconds', async () => {
  const time = virtualTime();
  let calls = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    ...time,
    fetchImpl: async () => ++calls === 1 ? json({ retry_after: 65.25 }, 429) : json({ ok: true }),
  });

  assert.deepEqual(await client.get('/test'), { ok: true });
  assert.deepEqual(time.waits, [65_250]);
});

test('supports rate limits that provide Retry-After only in the header', async () => {
  const time = virtualTime();
  let calls = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    ...time,
    fetchImpl: async () => ++calls === 1
      ? json({ message: 'Rate limited' }, 429, { 'Retry-After': '1.25' })
      : json({ ok: true }),
  });

  assert.deepEqual(await client.get('/test'), { ok: true });
  assert.deepEqual(time.waits, [1_250]);
});

test('pauses an exhausted route without blocking a different channel', async () => {
  const time = virtualTime();
  let calls = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    ...time,
    fetchImpl: async () => json({ ok: true }, 200, ++calls === 1 ? {
      'X-RateLimit-Bucket': 'messages',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset-After': '0.5',
    } : {}),
  });
  await client.getMessage('200000000000000001', '300000000000000001');
  await client.getMessage('200000000000000002', '300000000000000002');
  assert.deepEqual(time.waits, []);

  await client.getMessage('200000000000000001', '300000000000000003');
  assert.deepEqual(time.waits, [500]);
});

test('shares a global cooldown across routes even when the original request cannot retry', async () => {
  const time = virtualTime();
  let calls = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    maxRetries: 0,
    ...time,
    fetchImpl: async () => ++calls === 1
      ? json({ retry_after: 2, global: true }, 429)
      : json({ ok: true }),
  });
  await assert.rejects(() => client.get('/first'), /429/);
  await client.get('/second');

  assert.deepEqual(time.waits, [2_000]);
});

test('shares learned cooldowns across routes in the same Discord bucket', async () => {
  const time = virtualTime();
  let calls = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    ...time,
    fetchImpl: async () => json({ ok: true }, 200, {
      'X-RateLimit-Bucket': 'shared',
      'X-RateLimit-Remaining': ++calls === 2 ? '0' : '1',
      'X-RateLimit-Reset-After': '0.25',
    }),
  });
  await client.getChannel('200000000000000001');
  await client.listMessages('200000000000000001');
  await client.getChannel('200000000000000001');

  assert.deepEqual(time.waits, [250]);
});

test('one bot account rate limit does not delay another account', async () => {
  const time = virtualTime();
  const primary = new DiscordApiClient({
    token: 'primary-token',
    maxRetries: 0,
    ...time,
    fetchImpl: async () => json({ retry_after: 2, global: true }, 429),
  });
  const backup = new DiscordApiClient({ token: 'backup-token', ...time, fetchImpl: async () => json({ ok: true }) });
  await assert.rejects(() => primary.get('/test'), /429/);
  await backup.get('/test');

  assert.deepEqual(time.waits, []);
});

test('cancels rejected image bodies without downloading them', async () => {
  let cancellations = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancellations += 1; },
    }), { headers: { 'content-type': 'image/png', 'content-length': '1000' } }),
  });
  await assert.rejects(() => client.fetchImage('https://cdn.discordapp.com/image.png', { maxBytes: 10 }), /image limit/);

  assert.equal(cancellations, 1);
});

test('cancels an oversized streamed image and releases its reader', async () => {
  let cancellations = 0;
  let response;
  const client = new DiscordApiClient({
    token: 'mock-token',
    fetchImpl: async () => {
      response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(20)); },
        cancel() { cancellations += 1; },
      }), { headers: { 'content-type': 'image/png' } });
      return response;
    },
  });
  await assert.rejects(() => client.fetchImage('https://cdn.discordapp.com/image.png', { maxBytes: 10 }), /image limit/);

  assert.equal(cancellations, 1);
  assert.equal(response.body.locked, false);
});

test('coalesces overlapping image fetches without bypassing each caller byte limit', async () => {
  let calls = 0;
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const client = new DiscordApiClient({
    token: 'mock-token',
    fetchImpl: async () => {
      calls += 1;
      await setTimeout(5);
      return new Response(image, { headers: { 'content-type': 'image/png' } });
    },
  });
  const url = 'https://cdn.discordapp.com/image.png';
  const images = await Promise.all([client.fetchImage(url, { maxBytes: 10 }), client.fetchImage(url, { maxBytes: 10 })]);
  assert.deepEqual(images[0], images[1]);
  assert.equal(calls, 1);

  await assert.rejects(() => client.fetchImage(url, { maxBytes: 4 }), /image limit/);
  assert.equal(calls, 2);
});
