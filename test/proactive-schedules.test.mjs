import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduleManager } from '../src/proactive/schedules.mjs';
import { evaluateSchedulePredicate, scheduleConditionSchema } from '../src/proactive/schedule-conditions.mjs';
import { directMessageOwnerId as userId } from '../src/proactive/target.mjs';

const timestamp = Date.UTC(2026, 9, 5);
const guildId = '100000000000000001';
const channelId = '200000000000000001';
const messageId = (offset) => String((BigInt(timestamp - 1420070400000) << 22n) + BigInt(offset));

async function fixture(options = {}) {
  const root = options.root || await mkdtemp(join(tmpdir(), 'nova-schedules-'));
  const timers = new Map(); const deliveries = []; const requests = []; let counter = 0; let clock = timestamp; let hits = []; let appResult = { status: 'pending' };
  const service = { accountById: () => ({ id: 'default', client: {
    getGuild: async () => ({ id: guildId }), getChannel: async (id) => ({ id, guild_id: guildId }),
    searchGuildMessages: async (_, parameters) => { requests.push(parameters); const filtered = hits.filter((item) => BigInt(item.id) > BigInt(parameters.min_id)); return { total_results: filtered.length, messages: filtered.slice(parameters.offset, parameters.offset + parameters.limit).map((item) => [item]) }; },
  } }) };
  const apps = { list: async () => ({ tools: [{ name: 'github.read_pull_request' }] }), call: async () => ({ structuredContent: appResult, privateOwnerData: true }) };
  const manager = createScheduleManager({ service, accountId: 'default', apps, root, now: () => clock,
    setTimeout: (callback, delay) => { const id = ++counter; timers.set(id, { callback, delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    deliver: async (payload) => { deliveries.push(payload); return { confirmed: true, message: { id: messageId(deliveries.length) } }; }, ...options });
  await manager.ready;
  return { manager, root, timers, deliveries, requests, service, apps, setClock: (value) => { clock = value; }, setHits: (value) => { hits = value; }, setAppResult: (value) => { appResult = value; }, close: async () => { await manager.close(); if (!options.root) await rm(root, { recursive: true, force: true }); } };
}

test('schedules are opt-in, owner-only, private, timezone-explicit and bounded', async () => {
  const value = await fixture();
  try {
    assert.deepEqual(await value.manager.list({ userId }), []); assert.equal(value.timers.size, 0);
    assert.throws(() => value.manager.addReminder({ userId: 'stranger', content: 'Hi', runAt: timestamp + 60000 }), /Only the owner/);
    await assert.rejects(value.manager.addReminder({ userId, content: 'Hi', runAt: '2026-10-06T12:00:00' }), /explicit timezone/);
    await assert.rejects(value.manager.addReminder({ userId, content: 'Hi', runAt: timestamp }), /future/);
    await assert.rejects(value.manager.addAlert({ userId, content: 'Hi', condition: { type: 'discord', guildId }, intervalMinutes: 1 }), /Choose|Too small/);
    const reminder = await value.manager.addReminder({ userId, content: 'Review hotbar', runAt: '2026-10-06T12:00:00+08:00' });
    assert.equal(reminder.timeZone, 'Asia/Manila'); assert.equal(reminder.runAt, Date.UTC(2026, 9, 6, 4));
    assert.equal((await stat(value.root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(value.root, 'default.json'))).mode & 0o777, 0o600);
    assert.equal(value.deliveries.length, 0);
    assert.throws(() => value.manager.remove({ userId: 'stranger', id: reminder.id }), /Only the owner/);
  } finally { await value.close(); }
});

test('reminders survive restart, send once and avoid long-timeout overflow', async () => {
  const value = await fixture(); let restored;
  try {
    const reminder = await value.manager.addReminder({ userId, content: 'Review hotbar', runAt: timestamp + 40 * 86400000 });
    assert.equal([...value.timers.values()][0].delay, 2147483647);
    await value.manager.close();
    restored = createScheduleManager({ service: value.service, accountId: 'default', root: value.root, now: () => timestamp + 40 * 86400000, deliver: async (payload) => { value.deliveries.push(payload); return { confirmed: true }; }, setTimeout: () => 1, clearTimeout: () => {} });
    await restored.ready;
    const outcome = await restored.runNow({ userId, id: reminder.id, force: false });
    assert.equal(outcome.delivered, true); assert.equal(value.deliveries.length, 1);
    assert.match(value.deliveries[0].content, /Reminder: Review hotbar/); assert.equal(value.deliveries[0].ownerUserId, userId);
    assert.equal(value.deliveries[0].nonce.length, 24);
    await assert.rejects(restored.runNow({ userId, id: reminder.id }), /complete/);
  } finally { await restored?.close(); await value.close(); }
});

test('recurring reminders skip missed intervals rather than flooding the owner', async () => {
  const value = await fixture();
  try {
    const reminder = await value.manager.addReminder({ userId, content: 'Stretch', runAt: timestamp + 60000, intervalMinutes: 5 });
    assert.equal((await value.manager.runNow({ userId, id: reminder.id, force: false })).notDue, true);
    value.setClock(timestamp + 3600000);
    await value.manager.runNow({ userId, id: reminder.id, force: false });
    const stored = (await value.manager.list({ userId }))[0];
    assert.equal(stored.completedAt, null); assert.ok(stored.nextRunAt > timestamp + 3600000); assert.equal(value.deliveries.length, 1);
    await value.manager.update({ userId, id: reminder.id, paused: true }); assert.equal(value.timers.size, 0);
    await assert.rejects(value.manager.runNow({ userId, id: reminder.id }), /paused/);
    const futureReminder = await value.manager.addReminder({ userId, content: 'Tomorrow', runAt: timestamp + 86400000 });
    await value.manager.update({ userId, id: futureReminder.id, paused: true });
    assert.equal((await value.manager.update({ userId, id: futureReminder.id, paused: false })).nextRunAt, futureReminder.runAt);
  } finally { await value.close(); }
});

test('Discord conditions ignore old matches and advance only confirmed new-message delivery', async () => {
  const value = await fixture();
  try {
    const alert = await value.manager.addAlert({ userId, content: 'Hotbar update', condition: { type: 'discord', guildId, query: 'hotbar', channelIds: [channelId] }, repeat: true });
    value.setHits([{ id: messageId(-1), channel_id: channelId, content: 'old', author: { id: userId }, hit: true }]);
    assert.equal((await value.manager.runNow({ userId, id: alert.id })).matched, false); assert.equal(value.deliveries.length, 0);
    value.setHits([{ id: messageId(1), channel_id: channelId, content: 'new', author: { id: userId }, hit: true }]);
    await value.manager.runNow({ userId, id: alert.id });
    assert.equal(value.deliveries.length, 1); assert.match(value.deliveries[0].content, /discord\.com\/channels/);
    assert.equal((await value.manager.list({ userId }))[0].afterId, messageId(1));
    assert.equal((await value.manager.runNow({ userId, id: alert.id })).matched, false); assert.equal(value.deliveries.length, 1);
  } finally { await value.close(); }
});

test('app conditions are declarative, read-only and notify on false-to-true changes', async () => {
  const value = await fixture();
  try {
    await assert.rejects(value.manager.addAlert({ userId, content: 'Done', condition: { type: 'app', tool: 'github.merge', predicate: { path: ['status'], operator: 'equals', value: 'passed' } } }), /read-only/);
    const alert = await value.manager.addAlert({ userId, content: 'CI passed', repeat: true, condition: { type: 'app', tool: 'github.read_pull_request', arguments: { number: 1 }, predicate: { path: ['status'], operator: 'equals', value: 'passed' } } });
    assert.equal((await value.manager.runNow({ userId, id: alert.id })).matched, false);
    value.setAppResult({ status: 'passed' }); await value.manager.runNow({ userId, id: alert.id });
    assert.equal(value.deliveries[0].privateOwnerData, true); assert.equal((await value.manager.runNow({ userId, id: alert.id })).unchanged, true);
    value.setAppResult({ status: 'pending' }); await value.manager.runNow({ userId, id: alert.id });
    value.setAppResult({ status: 'passed' }); await value.manager.runNow({ userId, id: alert.id }); assert.equal(value.deliveries.length, 2);
    assert.throws(() => scheduleConditionSchema.parse({ type: 'app', tool: 'github.read_pull_request', arguments: { token: 'secret' }, predicate: { path: ['status'], operator: 'exists' } }), /credentials/);
    assert.throws(() => scheduleConditionSchema.parse({ type: 'app', tool: 'github.read_pull_request', predicate: { path: ['__proto__'], operator: 'exists' } }));
    assert.equal(evaluateSchedulePredicate({ labels: ['ready'] }, { path: ['labels'], operator: 'includes', value: 'ready' }), true);
    assert.equal(evaluateSchedulePredicate({ text: 'ready' }, { path: ['constructor'], operator: 'exists' }), false);
  } finally { await value.close(); }
});

test('unknown sends halt across restart until explicit owner resolution, without duplicate delivery', async () => {
  let sends = 0; const value = await fixture({ deliver: async () => { sends += 1; throw Object.assign(new Error('Disconnected'), { sendStatus: 'unknown' }); } }); let restored;
  try {
    const reminder = await value.manager.addReminder({ userId, content: 'Review', runAt: timestamp + 60000 });
    await assert.rejects(value.manager.runNow({ userId, id: reminder.id }), /Disconnected/);
    await assert.rejects(value.manager.runNow({ userId, id: reminder.id }), /verification/); assert.equal(sends, 1);
    await assert.rejects(value.manager.remove({ userId, id: reminder.id }), /Resolve/);
    await value.manager.close();
    restored = createScheduleManager({ accountId: 'default', service: value.service, root: value.root, now: () => timestamp, deliver: async () => { sends += 1; return { confirmed: true }; }, setTimeout: () => 1, clearTimeout: () => {} });
    await restored.ready; assert.equal((await restored.list({ userId }))[0].halted, true);
    await assert.rejects(restored.resolveOutcome({ userId, id: reminder.id, delivered: true }), /receipt/);
    await restored.resolveOutcome({ userId, id: reminder.id, delivered: true, receipt: { confirmed: true } });
    assert.equal((await restored.list({ userId }))[0].completedAt, timestamp); assert.equal(sends, 1);
    assert.equal(JSON.parse(await readFile(join(value.root, 'default.json'), 'utf8')).schedules[0].pendingDelivery, null);
  } finally { await restored?.close(); await value.close(); }
});

test('condition expiry and removal cancel quiet checks; one account has one process owner', async () => {
  const value = await fixture(); let competing;
  try {
    competing = createScheduleManager({ accountId: 'default', root: value.root, deliver: async () => ({ confirmed: true }) });
    await assert.rejects(competing.ready, /another listener/);
    const alert = await value.manager.addAlert({ userId, content: 'New topic', condition: { type: 'discord', guildId, query: 'topic' }, expiresAt: timestamp + 60000 });
    value.setClock(timestamp + 60001); assert.equal((await value.manager.runNow({ userId, id: alert.id })).expired, true);
    assert.equal(value.requests.length, 0); assert.equal(value.deliveries.length, 0);
    await value.manager.remove({ userId, id: alert.id }); assert.deepEqual(await value.manager.list({ userId }), []);
  } finally { await competing?.close(); await value.close(); }
});

test('rejected sends require owner resolution and an explicit retry uses a fresh operation', async () => {
  let attempts = 0; const payloads = [];
  const value = await fixture({ deliver: async (payload) => { payloads.push(payload); if (++attempts === 1) throw Object.assign(new Error('Forbidden'), { sendStatus: 'rejected' }); return { confirmed: true }; } });
  try {
    const reminder = await value.manager.addReminder({ userId, content: 'Review', runAt: timestamp + 60000 });
    await assert.rejects(value.manager.runNow({ userId, id: reminder.id }), /Forbidden/);
    assert.equal(value.timers.size, 0); assert.equal((await value.manager.list({ userId }))[0].pendingDelivery.sendStatus, 'rejected');
    await value.manager.resolveOutcome({ userId, id: reminder.id, delivered: false });
    await value.manager.runNow({ userId, id: reminder.id });
    assert.equal(attempts, 2); assert.notEqual(payloads[0].operationId, payloads[1].operationId); assert.notEqual(payloads[0].nonce, payloads[1].nonce);
  } finally { await value.close(); }
});

test('concurrent run requests share one check and cancellation prevents notification', async () => {
  let notifyStarted; const started = new Promise((resolve) => { notifyStarted = resolve; }); let searches = 0;
  const service = { accountById: () => ({ id: 'default', client: { getGuild: async () => ({ id: guildId }), searchGuildMessages: async (_, __, { signal }) => {
    searches += 1; notifyStarted(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  } } }) };
  const value = await fixture({ service });
  try {
    const alert = await value.manager.addAlert({ userId, content: 'Update', condition: { type: 'discord', guildId, query: 'topic' } });
    const first = value.manager.runNow({ userId, id: alert.id }); const second = value.manager.runNow({ userId, id: alert.id });
    const completed = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
    await started; await value.manager.remove({ userId, id: alert.id }); await completed;
    assert.equal(searches, 1); assert.equal(value.deliveries.length, 0);
  } finally { await value.close(); }
});
