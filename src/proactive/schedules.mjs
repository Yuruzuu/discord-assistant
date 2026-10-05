import { mkdir, chmod, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { directMessageOwnerId } from './target.mjs';
import { writeFileAtomic } from './state.mjs';
import { assertSnowflake } from '../discord-url.mjs';
import { scheduleConditionSchema, validateScheduleCondition, checkScheduleCondition } from './schedule-conditions.mjs';
import { acquireScheduleLease } from './schedule-lease.mjs';

const maximumTimerDelay = 2147483647;
const maximumSchedules = 50;
const interval = z.number().int().min(5).max(10080);
const content = z.string().trim().min(1).max(1500);
const timeZoneSchema = z.string().max(64).refine((value) => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Use a valid IANA timezone');
const instant = z.union([z.number().int().positive().max(8640000000000000), z.string().max(64).refine((value) => /(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value)), 'Use an ISO timestamp with an explicit timezone')]).transform((value) => typeof value === 'number' ? value : Date.parse(value));
export const reminderScheduleSchema = z.object({ content, runAt: instant, intervalMinutes: interval.optional(), timeZone: timeZoneSchema.optional() }).strict();
export const alertScheduleSchema = z.object({ content, condition: scheduleConditionSchema, intervalMinutes: interval.default(15), repeat: z.boolean().default(false), expiresAt: instant.optional(), timeZone: timeZoneSchema.optional() }).strict();
const updateSchema = z.object({ content: content.optional(), runAt: instant.optional(), intervalMinutes: interval.nullable().optional(), repeat: z.boolean().optional(), paused: z.boolean().optional(), expiresAt: instant.nullable().optional() }).strict();

function owner(userId) { if (userId !== directMessageOwnerId) throw new Error('Only the owner can manage reminders and alerts'); }
function currentSnowflake(timestamp) { return String(BigInt(Math.max(0, Math.floor(timestamp) - 1420070400000)) << 22n); }
function confirmed(receipt) { return receipt?.confirmed === true || Boolean(receipt?.sentMessages?.length) || Boolean(receipt?.message?.id); }
function copy(value) { return structuredClone(value); }

// Schedules deliver host-written text to the owner DM; quiet checks never start a model turn.
export function createScheduleManager({ service, accountId, deliver, apps, root = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'discord-mcp', 'schedules'), timeZone = 'Asia/Manila', checkTimeoutMs = 60000, now = Date.now, setTimeout: scheduleTimeout = globalThis.setTimeout, clearTimeout: cancelTimeout = globalThis.clearTimeout } = {}) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(accountId || '') || typeof deliver !== 'function') throw new Error('Schedules require an account and owner-DM delivery callback');
  if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1000 || checkTimeoutMs > 120000) throw new Error('Schedule timeout must be 1 to 120 seconds');
  timeZoneSchema.parse(timeZone);
  const filename = join(root, `${accountId}.json`);
  const schedules = new Map();
  const timers = new Map();
  const active = new Map();
  let writes = Promise.resolve();
  let mutations = Promise.resolve();
  let closed = false;
  let releaseLease;

  function persist() {
    const payload = JSON.stringify({ version: 1, ownerUserId: directMessageOwnerId, accountId, schedules: [...schedules.values()].map(copy) });
    const operation = writes.catch(() => {}).then(async () => { await writeFileAtomic(filename, payload); await chmod(filename, 0o600); });
    writes = operation;
    return operation;
  }
  function clearTimer(id) { if (timers.has(id)) cancelTimeout(timers.get(id)); timers.delete(id); }
  function arm(schedule) {
    clearTimer(schedule.id);
    if (closed || schedule.paused || schedule.halted || schedule.completedAt) return;
    const deadline = Math.min(schedule.nextRunAt, schedule.expiresAt ?? Infinity);
    const timer = scheduleTimeout(() => {
      timers.delete(schedule.id);
      if (now() < deadline) { arm(schedule); return; }
      void runNow({ userId: directMessageOwnerId, id: schedule.id, force: false }).catch(() => {});
    }, Math.min(maximumTimerDelay, Math.max(0, deadline - now())));
    timer.unref?.();
    timers.set(schedule.id, timer);
  }

  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    releaseLease = await acquireScheduleLease(filename);
    try {
      let stored;
      try { stored = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stored) {
        if (stored.version !== 1 || stored.accountId !== accountId || stored.ownerUserId !== directMessageOwnerId || !Array.isArray(stored.schedules) || stored.schedules.length > maximumSchedules) throw new Error('Invalid stored schedules');
        for (const schedule of stored.schedules) {
          if (!/^[a-f0-9-]{36}$/.test(schedule.id) || !['reminder', 'alert'].includes(schedule.kind) || !Number.isFinite(schedule.nextRunAt) || !Number.isFinite(schedule.createdAt) || !Number.isSafeInteger(schedule.sequence) || schedule.sequence < 0 || typeof schedule.paused !== 'boolean' || typeof schedule.halted !== 'boolean' || (schedule.completedAt !== null && !Number.isFinite(schedule.completedAt))) throw new Error('Invalid stored schedule');
          if (schedule.kind === 'reminder') reminderScheduleSchema.parse({ content: schedule.content, runAt: schedule.runAt, ...(schedule.intervalMinutes ? { intervalMinutes: schedule.intervalMinutes } : {}), timeZone: schedule.timeZone });
          else { alertScheduleSchema.parse({ content: schedule.content, condition: schedule.condition, intervalMinutes: schedule.intervalMinutes, repeat: schedule.repeat, ...(schedule.expiresAt ? { expiresAt: schedule.expiresAt } : {}), timeZone: schedule.timeZone }); if (schedule.condition.type === 'discord') assertSnowflake(schedule.afterId, 'alert cursor'); }
          if (schedule.pendingDelivery) {
            const pending = schedule.pendingDelivery;
            if (!/^schedule:[a-f0-9-]{36}:\d+$/.test(pending.operationId) || !/^[a-f0-9]{24}$/.test(pending.nonce) || !Number.isFinite(pending.scheduledAt)) throw new Error('Invalid pending scheduled delivery');
            if (pending.throughId) assertSnowflake(pending.throughId, 'pending alert cursor');
            schedule.halted = true; schedule.lastError = 'The previous scheduled delivery needs owner verification.';
          }
          schedules.set(schedule.id, schedule);
        }
      }
      await persist();
      for (const schedule of schedules.values()) arm(schedule);
    } catch (error) { await releaseLease(); releaseLease = null; throw error; }
  })();

  function mutate(userId, task) {
    owner(userId);
    const operation = mutations.catch(() => {}).then(async () => { await ready; if (closed) throw new Error('Schedule manager has stopped'); return task(); });
    mutations = operation;
    return operation;
  }
  function requireSchedule(id) { const schedule = schedules.get(id); if (!schedule) throw new Error('Unknown reminder or alert'); return schedule; }
  function capacity() { if (schedules.size >= maximumSchedules) throw new Error('At most 50 schedules are allowed; remove completed schedules first'); }
  function common(configuration, kind, timestamp) { return { id: randomUUID(), kind, ...configuration, timeZone: configuration.timeZone || timeZone, createdAt: timestamp, lastRunAt: null, lastError: null, paused: false, halted: false, completedAt: null, pendingDelivery: null, sequence: 0 }; }

  function addReminder({ userId, ...value }) {
    return mutate(userId, async () => {
      capacity(); const configuration = reminderScheduleSchema.parse(value); const timestamp = now();
      if (configuration.runAt <= timestamp) throw new Error('Reminder must be scheduled in the future');
      const schedule = { ...common(configuration, 'reminder', timestamp), nextRunAt: configuration.runAt };
      schedules.set(schedule.id, schedule); await persist(); arm(schedule); return copy(schedule);
    });
  }
  function addAlert({ userId, ...value }) {
    return mutate(userId, async () => {
      capacity(); const configuration = alertScheduleSchema.parse(value);
      configuration.condition = await validateScheduleCondition(configuration.condition, { service, accountId, apps, signal: AbortSignal.timeout(checkTimeoutMs) });
      if (closed) throw new Error('Schedule manager has stopped');
      const timestamp = now();
      if (configuration.expiresAt && configuration.expiresAt <= timestamp) throw new Error('Alert expiry must be in the future');
      const schedule = { ...common(configuration, 'alert', timestamp), nextRunAt: timestamp + configuration.intervalMinutes * 60000, lastMatched: false, ...(configuration.condition.type === 'discord' ? { afterId: currentSnowflake(timestamp) } : {}) };
      schedules.set(schedule.id, schedule); await persist(); arm(schedule); return copy(schedule);
    });
  }
  function update({ userId, id, ...value }) {
    return mutate(userId, async () => {
      const schedule = requireSchedule(id); const patch = updateSchema.parse(value);
      if (active.has(id) || schedule.pendingDelivery) throw new Error('Stop or resolve the current schedule operation before editing');
      if (schedule.kind === 'alert' && (patch.runAt !== undefined || patch.intervalMinutes === null)) throw new Error('Alerts require a check interval and have no runAt');
      if (schedule.kind === 'reminder' && (patch.repeat !== undefined || patch.expiresAt !== undefined)) throw new Error('Reminder repetition is configured with intervalMinutes');
      if (patch.runAt !== undefined && patch.runAt <= now()) throw new Error('Reminder must be scheduled in the future');
      if (patch.expiresAt !== undefined && patch.expiresAt !== null && patch.expiresAt <= now()) throw new Error('Alert expiry must be in the future');
      Object.assign(schedule, patch);
      if (patch.runAt !== undefined) { schedule.nextRunAt = patch.runAt; schedule.completedAt = null; }
      else if (schedule.kind === 'alert' && (patch.intervalMinutes !== undefined || patch.paused === false)) schedule.nextRunAt = now() + schedule.intervalMinutes * 60000;
      else if (patch.paused === false) schedule.nextRunAt = Math.max(now(), schedule.nextRunAt);
      await persist(); arm(schedule); return copy(schedule);
    });
  }

  function advance(schedule, pending) {
    if (pending.throughId) schedule.afterId = pending.throughId;
    if (schedule.kind === 'alert') schedule.lastMatched = true;
    if ((schedule.kind === 'reminder' && !schedule.intervalMinutes) || (schedule.kind === 'alert' && !schedule.repeat)) schedule.completedAt = now();
    else if (schedule.kind === 'reminder') {
      const intervalMs = schedule.intervalMinutes * 60000;
      schedule.nextRunAt = pending.scheduledAt + Math.max(1, Math.floor((now() - pending.scheduledAt) / intervalMs) + 1) * intervalMs;
    }
    schedule.pendingDelivery = null; schedule.halted = false; schedule.lastError = null;
  }

  async function execute(schedule, cancellation) {
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(checkTimeoutMs)]);
    try {
      signal.throwIfAborted();
      if (schedule.expiresAt && schedule.expiresAt <= now()) { schedule.completedAt = now(); return { id: schedule.id, delivered: false, expired: true }; }
      schedule.lastRunAt = now();
      let condition = { matched: true };
      if (schedule.kind === 'alert') condition = await checkScheduleCondition(schedule, { service, accountId, apps, signal });
      signal.throwIfAborted();
      if (!condition.matched) { schedule.lastMatched = false; schedule.lastError = null; return { id: schedule.id, delivered: false, matched: false }; }
      if (schedule.kind === 'alert' && schedule.condition.type === 'app' && schedule.lastMatched) return { id: schedule.id, delivered: false, matched: true, unchanged: true };
      const operationId = `schedule:${schedule.id}:${++schedule.sequence}`;
      const nonce = createHash('sha256').update(operationId).digest('hex').slice(0, 24);
      schedule.pendingDelivery = { operationId, nonce, scheduledAt: schedule.nextRunAt, ...(condition.throughId ? { throughId: condition.throughId } : {}) };
      await persist(); signal.throwIfAborted();
      const payload = { id: schedule.id, kind: schedule.kind, operationId, nonce, ownerUserId: directMessageOwnerId, content: `${schedule.kind === 'reminder' ? 'Reminder' : 'Alert'}: ${schedule.content}${condition.links?.length ? `\n\n${condition.links.join('\n')}` : ''}`, ...(condition.privateOwnerData ? { privateOwnerData: true } : {}) };
      let receipt;
      try { receipt = await deliver(payload, signal); }
      catch (error) { schedule.pendingDelivery.sendStatus = error.sendStatus === 'rejected' ? 'rejected' : 'unknown'; schedule.halted = true; throw error; }
      if (!confirmed(receipt)) { schedule.pendingDelivery.sendStatus = 'unknown'; schedule.halted = true; throw new Error('Scheduled delivery outcome is unknown; verify it before continuing'); }
      advance(schedule, schedule.pendingDelivery);
      return { id: schedule.id, delivered: true, receipt };
    } catch (error) {
      if (schedule.pendingDelivery) schedule.halted = true;
      schedule.lastError = signal.aborted ? 'Schedule operation cancelled.' : 'Schedule check or delivery failed; inspect the listener logs and delivery status.';
      throw error;
    } finally {
      if (schedules.has(schedule.id)) {
        if (schedule.kind === 'alert') schedule.nextRunAt = now() + schedule.intervalMinutes * 60000;
        else if (!schedule.pendingDelivery && !schedule.completedAt && schedule.nextRunAt <= now()) schedule.nextRunAt = now() + 300000;
        await persist(); arm(schedule);
      }
    }
  }
  async function runNow({ userId, id, force = true }) {
    owner(userId); await ready; if (closed) throw new Error('Schedule manager has stopped');
    const schedule = requireSchedule(id);
    if (schedule.halted || schedule.pendingDelivery) throw new Error('Scheduled delivery needs owner verification before continuing');
    if (schedule.paused || schedule.completedAt) throw new Error('Schedule is paused or complete');
    if (!force && now() < schedule.nextRunAt && !(schedule.expiresAt && schedule.expiresAt <= now())) { arm(schedule); return { id, delivered: false, notDue: true }; }
    if (active.has(id)) return active.get(id).promise;
    clearTimer(id); const cancellation = new AbortController(); const entry = { cancellation };
    entry.promise = execute(schedule, cancellation).finally(() => active.delete(id)); active.set(id, entry);
    return entry.promise;
  }
  async function list({ userId } = {}) { owner(userId); await ready; return [...schedules.values()].map(copy); }
  async function status({ userId } = {}) { return { schedules: await list({ userId }), running: [...active.keys()], stopped: closed }; }
  function remove({ userId, id }) {
    return mutate(userId, async () => {
      const schedule = requireSchedule(id);
      if (schedule.pendingDelivery) throw new Error('Resolve the scheduled delivery before removing it');
      active.get(id)?.cancellation.abort(); clearTimer(id); schedules.delete(id); await persist(); return { id, removed: true };
    });
  }
  function resolveOutcome({ userId, id, delivered, receipt }) {
    return mutate(userId, async () => {
      const schedule = requireSchedule(id);
      if (!schedule.halted || !schedule.pendingDelivery || active.has(id)) throw new Error('There is no uncertain scheduled delivery to resolve');
      if (typeof delivered !== 'boolean') throw new Error('Specify whether the scheduled message was delivered');
      if (delivered && !confirmed(receipt)) throw new Error('A confirmed delivery receipt is required');
      if (delivered) advance(schedule, schedule.pendingDelivery);
      else { schedule.pendingDelivery = null; schedule.halted = false; schedule.lastError = null; }
      if (schedule.kind === 'alert') schedule.nextRunAt = now() + schedule.intervalMinutes * 60000;
      await persist(); arm(schedule); return copy(schedule);
    });
  }
  async function close() {
    if (closed) return; closed = true;
    for (const id of timers.keys()) clearTimer(id);
    for (const entry of active.values()) entry.cancellation.abort();
    await ready.catch(() => {}); await mutations.catch(() => {}); await Promise.allSettled([...active.values()].map((entry) => entry.promise)); await writes.catch(() => {});
    await releaseLease?.(); releaseLease = null;
  }
  return { ready, addReminder, addAlert, update, list, status, remove, runNow, resolveOutcome, close };
}
