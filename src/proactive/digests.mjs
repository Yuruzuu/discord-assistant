import { mkdir, readFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { searchMessages } from '../search.mjs';
import { assertSnowflake, compareSnowflakes } from '../discord-url.mjs';
import { directMessageOwnerId } from './target.mjs';
import { writeFileAtomic } from './state.mjs';

function owner(userId) {
  if (userId !== directMessageOwnerId) throw new Error('Only the owner can manage digests');
}

function validateSchedule(value) {
  assertSnowflake(value.guildId, 'guildId');
  if (typeof value.query !== 'string' || value.query.length > 1024) throw new Error('Digest query must be at most 1024 characters');
  for (const key of ['authorIds', 'channelIds']) {
    if (!Array.isArray(value[key]) || value[key].length > 25) throw new Error(`Provide at most 25 ${key}`);
    for (const identifier of value[key]) assertSnowflake(identifier, key);
  }
  if (!value.query.trim() && !value.authorIds.length && !value.channelIds.length) throw new Error('Select a digest topic, author or channel');
  if (!Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes < 15 || value.intervalMinutes > 10080) throw new Error('Digest interval must be 15 minutes to one week');
  if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 250) throw new Error('Digest limit must be 1 to 250');
}

function currentSnowflake(timestamp) {
  return String((BigInt(Math.max(0, Math.floor(timestamp) - 1420070400000))) << 22n);
}

export function formatDigest(payload) {
  const title = `Discord digest${payload.query ? `: ${payload.query}` : ''} — ${payload.messages.length} new ${payload.messages.length === 1 ? 'message' : 'messages'}`;
  const lines = payload.messages.slice(0, 25).map((message) => {
    const author = (message.author?.displayName || message.author?.username || message.authorId || 'Unknown author').replace(/[\r\n]/g, ' ').slice(0, 100);
    const excerpt = (message.content || '[attachment or embed]').replace(/[\r\n]/g, ' ').slice(0, 300);
    return `${author}: ${excerpt}\n${message.url || `https://discord.com/channels/${payload.guildId}/${message.channelId}/${message.id}`}`;
  });
  if (payload.messages.length > 25) lines.push(`${payload.messages.length - 25} additional matches are included in the digest result.`);
  if (payload.continuation) lines.push('More matches are available; the next run continues after these messages.');
  return [title, ...lines].join('\n\n');
}

export function createDigestManager({ service, accountId, root = join(homedir(), '.local', 'share', 'discord-mcp', 'digests'), deliver, now = Date.now, setTimeout: scheduleTimeout = globalThis.setTimeout, clearTimeout: cancelTimeout = globalThis.clearTimeout } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId || '') || typeof deliver !== 'function') throw new Error('Digest manager requires an account and delivery callback');
  const filename = join(root, `${accountId}.json`);
  const schedules = new Map();
  const timers = new Map();
  const active = new Map();
  let closed = false;
  let writes = Promise.resolve();

  function snapshot(schedule) {
    return { ...schedule, authorIds: [...schedule.authorIds], channelIds: [...schedule.channelIds] };
  }

  async function persist() {
    const payload = JSON.stringify({ version: 1, ownerUserId: directMessageOwnerId, schedules: [...schedules.values()].map(snapshot) });
    const operation = writes.catch(() => {}).then(async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      await writeFileAtomic(filename, payload);
      await chmod(filename, 0o600);
    });
    writes = operation;
    return operation;
  }

  function arm(schedule) {
    if (timers.has(schedule.id)) cancelTimeout(timers.get(schedule.id));
    timers.delete(schedule.id);
    if (closed || schedule.halted) return;
    const delay = Math.max(0, schedule.nextRunAt - now());
    const timer = scheduleTimeout(() => { timers.delete(schedule.id); void runNow({ userId: directMessageOwnerId, id: schedule.id }).catch(() => {}); }, delay);
    timer.unref?.();
    timers.set(schedule.id, timer);
  }

  const ready = (async () => {
    let stored;
    try { stored = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return; }
    if (stored.version !== 1 || stored.ownerUserId !== directMessageOwnerId || !Array.isArray(stored.schedules) || stored.schedules.length > 20) throw new Error('Invalid stored digest settings');
    for (const schedule of stored.schedules) {
      validateSchedule(schedule);
      if (!/^[a-f0-9-]{36}$/.test(schedule.id) || !Number.isFinite(schedule.nextRunAt)) throw new Error('Invalid stored digest schedule');
      assertSnowflake(schedule.afterId, 'digest cursor');
      if (schedule.pendingDelivery) { schedule.halted = true; schedule.lastError = 'The previous digest delivery needs verification before continuing.'; }
      schedules.set(schedule.id, schedule);
    }
    await persist();
    for (const schedule of schedules.values()) arm(schedule);
  })();

  async function add({ userId, guildId, query = '', authorIds = [], channelIds = [], intervalMinutes = 60, limit = 250 }) {
    owner(userId);
    await ready;
    if (closed) throw new Error('Digest manager has stopped');
    if (schedules.size >= 20) throw new Error('At most 20 digest schedules are allowed');
    const configuration = { guildId, query, authorIds: [...new Set(authorIds)], channelIds: [...new Set(channelIds)], intervalMinutes, limit };
    validateSchedule(configuration);
    await service.accountById(accountId).client.getGuild(guildId);
    if (closed) throw new Error('Digest manager has stopped');
    const timestamp = now();
    const schedule = { id: randomUUID(), ...configuration, afterId: currentSnowflake(timestamp), createdAt: timestamp, nextRunAt: timestamp + intervalMinutes * 60000, lastRunAt: null, lastError: null, halted: false, pendingDelivery: null };
    schedules.set(schedule.id, schedule);
    await persist();
    arm(schedule);
    return snapshot(schedule);
  }

  async function execute(schedule, cancellation) {
    const signal = cancellation.signal;
    try {
      signal.throwIfAborted();
      const result = await searchMessages(service, { accountId, guildId: schedule.guildId, query: schedule.query, authorIds: schedule.authorIds, channelIds: schedule.channelIds, limit: schedule.limit, afterId: schedule.afterId, sortBy: 'timestamp', sortOrder: 'asc' }, { signal });
      signal.throwIfAborted();
      if (result.doingHistoricalIndex) throw new Error('Discord is still indexing this search; digest delivery will wait for complete results.');
      const messages = result.messages.filter((message) => compareSnowflakes(message.id, schedule.afterId) > 0).sort((left, right) => compareSnowflakes(left.id, right.id));
      schedule.lastRunAt = now();
      if (!messages.length) { schedule.lastError = null; return { id: schedule.id, delivered: false, messageCount: 0 }; }
      const throughId = messages.at(-1).id;
      const operationId = `${schedule.id}:${schedule.afterId}:${throughId}`;
      schedule.pendingDelivery = { operationId, throughId, messageCount: messages.length };
      await persist();
      signal.throwIfAborted();
      const payload = { id: schedule.id, operationId, guildId: schedule.guildId, query: schedule.query, ownerUserId: directMessageOwnerId, messages, continuation: result.hasMore, afterId: schedule.afterId, throughId };
      let receipt;
      try { receipt = await deliver({ ...payload, content: formatDigest(payload) }, signal); }
      catch (error) {
        if (error.sendStatus === 'rejected') schedule.pendingDelivery = null;
        else schedule.halted = true;
        throw error;
      }
      if (!receipt?.confirmed && !receipt?.sentMessages?.length) { schedule.halted = true; throw new Error('Digest delivery outcome is unknown; verify it before continuing.'); }
      schedule.afterId = throughId;
      schedule.pendingDelivery = null;
      schedule.lastError = null;
      return { id: schedule.id, delivered: true, messageCount: messages.length, receipt };
    } catch (error) {
      if (schedule.pendingDelivery) schedule.halted = true;
      schedule.lastError = signal.aborted ? 'Digest run cancelled.' : String(error.message).slice(0, 500);
      throw error;
    } finally {
      if (schedules.has(schedule.id)) {
        schedule.nextRunAt = now() + schedule.intervalMinutes * 60000;
        await persist();
        arm(schedule);
      }
    }
  }

  async function runNow({ userId, id }) {
    owner(userId);
    await ready;
    if (closed) throw new Error('Digest manager has stopped');
    const schedule = schedules.get(id);
    if (!schedule) throw new Error('Unknown digest schedule');
    if (schedule.halted) throw new Error('Digest delivery needs verification before continuing');
    if (active.has(id)) return active.get(id).promise;
    const cancellation = new AbortController();
    const entry = { cancellation };
    entry.promise = execute(schedule, cancellation).finally(() => active.delete(id));
    active.set(id, entry);
    return entry.promise;
  }

  async function list({ userId } = {}) { owner(userId); await ready; return [...schedules.values()].map(snapshot); }
  async function status({ userId } = {}) { return { schedules: await list({ userId }), running: [...active.keys()], stopped: closed }; }
  async function remove({ userId, id }) {
    owner(userId);
    await ready;
    if (!schedules.has(id)) throw new Error('Unknown digest schedule');
    active.get(id)?.cancellation.abort();
    if (timers.has(id)) cancelTimeout(timers.get(id));
    timers.delete(id);
    schedules.delete(id);
    await persist();
    return { id, removed: true };
  }
  async function resolveOutcome({ userId, id, delivered, receipt }) {
    owner(userId);
    await ready;
    const schedule = schedules.get(id);
    if (!schedule?.halted || !schedule.pendingDelivery) throw new Error('There is no uncertain digest delivery to resolve');
    if (typeof delivered !== 'boolean') throw new Error('Specify whether the digest was delivered');
    if (delivered) {
      if (!receipt?.confirmed && !receipt?.sentMessages?.length) throw new Error('A confirmed receipt is required');
      schedule.afterId = schedule.pendingDelivery.throughId;
    }
    schedule.pendingDelivery = null;
    schedule.halted = false;
    schedule.lastError = null;
    schedule.nextRunAt = now() + schedule.intervalMinutes * 60000;
    await persist();
    arm(schedule);
    return snapshot(schedule);
  }
  async function close() {
    closed = true;
    for (const timer of timers.values()) cancelTimeout(timer);
    timers.clear();
    for (const entry of active.values()) entry.cancellation.abort();
    await ready;
    await Promise.allSettled([...active.values()].map((entry) => entry.promise));
    await writes;
  }

  return { ready, add, list, status, remove, runNow, resolveOutcome, close };
}
