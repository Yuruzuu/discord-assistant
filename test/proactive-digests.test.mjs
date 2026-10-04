import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDigestManager } from '../src/proactive/digests.mjs';
import { directMessageOwnerId as userId } from '../src/proactive/target.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const timestamp = Date.UTC(2026, 9, 5);
const base = BigInt(timestamp - 1420070400000) << 22n;
const message = (offset) => ({ id: String(base + BigInt(offset)), channel_id: channelId, content: `Topic ${offset}`, author: { id: userId, username: 'Owner' }, hit: true });

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nova-digest-'));
  const requests = [];
  const deliveries = [];
  const timers = new Map();
  let nextTimer = 0;
  let hits = [];
  let clock = timestamp;
  const service = { accountById: () => ({ id: 'default', client: {
    getGuild: async () => ({ id: guildId }),
    searchGuildMessages: async (_, parameters) => {
      requests.push(parameters);
      const filtered = hits.filter((entry) => BigInt(entry.id) > BigInt(parameters.min_id));
      return { total_results: filtered.length, messages: filtered.slice(parameters.offset, parameters.offset + parameters.limit).map((entry) => [entry]) };
    },
  } }) };
  const manager = createDigestManager({ service, accountId: 'default', root, now: () => clock, setTimeout: (callback, delay) => { const key = ++nextTimer; timers.set(key, { callback, delay }); return key; }, clearTimeout: (key) => timers.delete(key), deliver: async (payload) => { deliveries.push(payload); return { confirmed: true, id: `receipt-${deliveries.length}` }; }, ...options });
  await manager.ready;
  return { manager, root, requests, deliveries, timers, service, setHits: (value) => { hits = value; }, setClock: (value) => { clock = value; }, close: async () => { await manager.close(); await rm(root, { recursive: true, force: true }); } };
}

test('digests stay disabled until an owner explicitly adds a bounded topic or author schedule', async () => {
  const fixtureData = await fixture();
  const { manager, timers, deliveries, root } = fixtureData;
  try {
    assert.equal(timers.size, 0);
    assert.equal(deliveries.length, 0);
    await assert.rejects(manager.add({ userId: 'stranger', guildId, query: 'hotbar' }), /Only the owner/);
    await assert.rejects(manager.add({ userId, guildId, query: 'hotbar', intervalMinutes: 14 }), /interval/);
    await assert.rejects(manager.add({ userId, guildId }), /Select a digest/);
    const schedule = await manager.add({ userId, guildId, query: 'hotbar', authorIds: [userId], intervalMinutes: 15 });
    assert.equal(schedule.afterId, String(base));
    assert.equal(timers.size, 1);
    assert.equal(deliveries.length, 0);
    assert.equal((await stat(join(root, 'default.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await manager.list({ userId }))[0].id, schedule.id);
    await manager.remove({ userId, id: schedule.id });
    assert.equal(timers.size, 0);
  } finally { await fixtureData.close(); }
});

test('incremental digest delivery advances its cursor only after confirmed receipts and resumes new matches in order', async () => {
  const fixtureData = await fixture();
  const { manager, setHits, requests, deliveries } = fixtureData;
  try {
    const schedule = await manager.add({ userId, guildId, query: 'hotbar', limit: 2 });
    setHits([message(-1), message(1), message(2), message(3)]);
    const first = await manager.runNow({ userId, id: schedule.id });
    assert.equal(first.messageCount, 2);
    assert.deepEqual(deliveries[0].messages.map((entry) => entry.id), [message(1).id, message(2).id]);
    assert.equal(requests[0].sort_order, 'asc');
    assert.equal(deliveries[0].ownerUserId, userId);
    assert.match(deliveries[0].content, /discord\.com\/channels/);
    assert.equal((await manager.list({ userId }))[0].afterId, message(2).id);
    await manager.runNow({ userId, id: schedule.id });
    assert.deepEqual(deliveries[1].messages.map((entry) => entry.id), [message(3).id]);
    assert.equal((await manager.runNow({ userId, id: schedule.id })).delivered, false);
    assert.equal(deliveries.length, 2);
  } finally { await fixtureData.close(); }
});

test('unknown outcomes halt and remain halted across restart until owner verification resolves them', async () => {
  const fixtureData = await fixture({ deliver: async () => { const error = new Error('connection disappeared'); error.sendStatus = 'unknown'; throw error; } });
  const { manager, setHits, root, service } = fixtureData;
  let restored;
  try {
    const schedule = await manager.add({ userId, guildId, query: 'hotbar' });
    setHits([message(1)]);
    await assert.rejects(manager.runNow({ userId, id: schedule.id }), /connection/);
    assert.equal((await manager.list({ userId }))[0].afterId, String(base));
    await assert.rejects(manager.runNow({ userId, id: schedule.id }), /verification/);
    await manager.close();
    restored = createDigestManager({ service, accountId: 'default', root, now: () => timestamp, deliver: async () => ({ confirmed: true }) });
    await restored.ready;
    assert.equal((await restored.list({ userId }))[0].halted, true);
    await assert.rejects(restored.resolveOutcome({ userId: 'stranger', id: schedule.id, delivered: true, receipt: { confirmed: true } }), /Only the owner/);
    await restored.resolveOutcome({ userId, id: schedule.id, delivered: true, receipt: { confirmed: true } });
    assert.equal((await restored.list({ userId }))[0].afterId, message(1).id);
    assert.equal((await restored.list({ userId }))[0].halted, false);
    const stored = JSON.parse(await readFile(join(root, 'default.json'), 'utf8'));
    assert.equal(stored.schedules[0].pendingDelivery, null);
  } finally { await restored?.close(); await fixtureData.close(); }
});

test('concurrent runs share one operation and removal cancels searching before any delivery', async () => {
  let started;
  const opening = new Promise((resolve) => { started = resolve; });
  let requests = 0;
  let delivered = 0;
  const service = { accountById: () => ({ id: 'default', client: { getGuild: async () => ({ id: guildId }), searchGuildMessages: async (_, __, { signal }) => {
    requests += 1; started();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  } } }) };
  const fixtureData = await fixture({ service, deliver: async () => { delivered += 1; return { confirmed: true }; } });
  try {
    const schedule = await fixtureData.manager.add({ userId, guildId, query: 'topic' });
    const first = fixtureData.manager.runNow({ userId, id: schedule.id });
    const second = fixtureData.manager.runNow({ userId, id: schedule.id });
    const completed = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
    await opening;
    await fixtureData.manager.remove({ userId, id: schedule.id });
    await completed;
    assert.equal(requests, 1);
    assert.equal(delivered, 0);
    assert.deepEqual(await fixtureData.manager.list({ userId }), []);
  } finally { await fixtureData.close(); }
});
