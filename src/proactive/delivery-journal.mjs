import { mkdir, readFile, chmod, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSnowflake } from '../discord-url.mjs';
import { directMessageOwnerId } from './target.mjs';
import { writeState } from './state.mjs';

const openJournals = new Map();
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const maximumEntries = 2000;

function operationKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,240}$/.test(value)) throw new Error('Invalid delivery operation ID');
  return value;
}

function identifier(value, label) {
  if (value === undefined || value === null) return undefined;
  assertSnowflake(value, label);
  return value;
}

function metadata(value = {}, channelId) {
  if (value.channelId !== undefined && value.channelId !== channelId) throw new Error('Delivery metadata belongs to a different channel');
  const result = { channelId };
  if (value.nonce !== undefined) {
    if (typeof value.nonce !== 'string' || !/^[A-Za-z0-9:_-]{1,25}$/.test(value.nonce)) throw new Error('Invalid delivery nonce');
    result.nonce = value.nonce;
  }
  for (const key of ['triggerMessageId', 'guildId']) {
    const selected = identifier(value[key], key);
    if (selected) result[key] = selected;
  }
  return result;
}

function receipt(value, accountId, channelId) {
  if (!value?.message) throw new Error('A confirmed Discord message receipt is required');
  if (value.accountId !== undefined && value.accountId !== accountId) throw new Error('Receipt belongs to a different account');
  const messageId = identifier(value.message.id, 'receipt message ID');
  if (!messageId) throw new Error('A confirmed Discord message ID is required');
  const actualChannel = value.message.channelId || value.message.channel_id || channelId;
  if (actualChannel !== channelId) throw new Error('Receipt belongs to a different channel');
  const guildId = identifier(value.message.guildId || value.message.guild_id, 'receipt guild ID');
  return {
    accountId,
    ...metadata({ nonce: value.nonce }, channelId),
    message: { id: messageId, channelId, ...(guildId ? { guildId } : {}), url: `https://discord.com/channels/${guildId || '@me'}/${channelId}/${messageId}` },
  };
}

function processAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId < 1) return false;
  try { process.kill(processId, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function acquireLease(filename) {
  const lease = `${filename}.lock`;
  const identity = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lease, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, identity })); }
      finally { await handle.close(); }
      return async () => {
        let existing;
        try { existing = JSON.parse(await readFile(lease, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (existing.identity === identity) await unlink(lease);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(await readFile(lease, 'utf8')); }
      catch (readError) { if (readError.code === 'ENOENT') continue; throw new Error('Delivery journal lease is incomplete; another process may be opening it'); }
      if (processAlive(existing.pid)) throw new Error('Delivery journal is already owned by another process');
      const recoveryName = `${lease}.recovery`;
      let recovery;
      try {
        recovery = await open(recoveryName, 'wx', 0o600);
        const current = JSON.parse(await readFile(lease, 'utf8'));
        if (processAlive(current.pid)) throw new Error('Delivery journal is already owned by another process');
        await unlink(lease);
      } catch (recoveryError) {
        if (!['ENOENT', 'EEXIST'].includes(recoveryError.code)) throw recoveryError;
        if (recoveryError.code === 'EEXIST') throw new Error('Another process is recovering this delivery journal');
      } finally {
        if (recovery) { await recovery.close(); await unlink(recoveryName).catch(() => {}); }
      }
    }
  }
  throw new Error('Unable to acquire delivery journal ownership');
}

async function openJournal({ accountId, channelId, root, now }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const filename = join(root, `${accountId}-${channelId}.json`);
  const releaseLease = await acquireLease(filename);
  const operations = new Map();
  const ingress = new Map();
  let sequence = Promise.resolve();
  let closing = false;

  function prune(map, unfinished) {
    const cutoff = now() - retentionMs;
    for (const [key, entry] of map) if (!unfinished(entry) && entry.updatedAt < cutoff) map.delete(key);
    if (map.size >= maximumEntries) {
      const terminal = [...map].filter(([, entry]) => !unfinished(entry)).sort((left, right) => left[1].updatedAt - right[1].updatedAt);
      for (const [key] of terminal) { if (map.size < maximumEntries) break; map.delete(key); }
    }
  }
  const pruneOperations = () => prune(operations, (entry) => entry.status === 'pending' || entry.status === 'unknown');
  const pruneIngress = () => prune(ingress, (entry) => entry.status !== 'completed');

  async function save() {
    await writeState(filename, { version: 1, accountId, channelId, operations: [...operations.values()], ingress: [...ingress.values()] });
    await chmod(filename, 0o600);
  }

  function serial(operation) {
    if (closing) return Promise.reject(new Error('Delivery journal has closed'));
    const promise = sequence.catch(() => {}).then(operation);
    sequence = promise;
    return promise;
  }

  try {
    let stored;
    try { stored = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stored) {
      if (stored.version !== 1 || stored.accountId !== accountId || stored.channelId !== channelId || !Array.isArray(stored.operations) || !Array.isArray(stored.ingress) || stored.operations.length > maximumEntries || stored.ingress.length > maximumEntries) throw new Error('Invalid delivery journal');
      for (const entry of stored.operations) {
        operationKey(entry.operationId);
        if (!['pending', 'sent', 'unknown', 'rejected'].includes(entry.status) || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) throw new Error('Invalid delivery journal operation');
        operations.set(entry.operationId, { operationId: entry.operationId, status: entry.status === 'pending' ? 'unknown' : entry.status, createdAt: entry.createdAt, updatedAt: entry.updatedAt, ...metadata(entry, channelId), ...(entry.receipt ? { receipt: receipt(entry.receipt, accountId, channelId) } : {}) });
      }
      for (const entry of stored.ingress) {
        identifier(entry.messageId, 'ingress message ID');
        if (!entry.messageId || entry.ownerUserId !== directMessageOwnerId || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt) || !['pending', 'running', 'completed'].includes(entry.status)) throw new Error('Invalid delivery journal ingress');
        ingress.set(entry.messageId, { messageId: entry.messageId, ownerUserId: directMessageOwnerId, channelId, ...(identifier(entry.guildId, 'ingress guild ID') ? { guildId: entry.guildId } : {}), createdAt: entry.createdAt, updatedAt: entry.updatedAt, status: entry.status === 'completed' ? 'completed' : 'pending', ...(entry.outcome ? { outcome: ['sent', 'skipped', 'failed', 'cancelled'].includes(entry.outcome) ? entry.outcome : 'failed' } : {}) });
      }
    }
    pruneOperations();
    pruneIngress();
    await save();
  } catch (error) { await releaseLease(); throw error; }

  function copy(value) { return value ? structuredClone(value) : null; }
  function requireCapacity(map) { if (map.size >= maximumEntries) throw new Error('Delivery journal is full of unfinished records; resolve them before continuing'); }

  return {
    lookup: (operationId) => serial(() => copy(operations.get(operationKey(operationId)))),
    begin: (operationId, value) => serial(async () => {
      operationKey(operationId);
      const existing = operations.get(operationId);
      if (existing?.status === 'unknown' || existing?.status === 'pending') throw new Error('Delivery outcome is uncertain; verify it before sending');
      if (existing?.status === 'sent') return copy(existing);
      pruneOperations();
      if (!existing) requireCapacity(operations);
      const entry = { operationId, status: 'pending', createdAt: existing?.createdAt || now(), updatedAt: now(), ...metadata(value, channelId) };
      operations.set(operationId, entry);
      await save();
      return copy(entry);
    }),
    record: (operationId, value) => serial(async () => {
      operationKey(operationId);
      const confirmed = receipt(value, accountId, channelId);
      const existing = operations.get(operationId);
      if (!existing) { pruneOperations(); requireCapacity(operations); }
      const entry = { operationId, status: 'sent', createdAt: existing?.createdAt || now(), updatedAt: now(), ...metadata(existing || {}, channelId), receipt: confirmed };
      operations.set(operationId, entry);
      await save();
      return copy(entry);
    }),
    unknown: (operationId, value) => serial(async () => {
      operationKey(operationId);
      const existing = operations.get(operationId);
      if (existing?.status === 'sent') return copy(existing);
      if (!existing) { pruneOperations(); requireCapacity(operations); }
      const entry = { operationId, status: 'unknown', createdAt: existing?.createdAt || now(), updatedAt: now(), ...metadata({ ...existing, ...value }, channelId) };
      operations.set(operationId, entry);
      await save();
      return copy(entry);
    }),
    resolve: (operationId, { delivered, receipt: value } = {}) => serial(async () => {
      const existing = operations.get(operationKey(operationId));
      if (!existing || !['pending', 'unknown'].includes(existing.status)) throw new Error('There is no uncertain delivery to resolve');
      if (typeof delivered !== 'boolean') throw new Error('Specify whether the message was delivered');
      const confirmed = delivered ? receipt(value, accountId, channelId) : undefined;
      const entry = { ...existing, status: delivered ? 'sent' : 'rejected', updatedAt: now(), ...(confirmed ? { receipt: confirmed } : {}) };
      operations.set(operationId, entry);
      await save();
      return copy(entry);
    }),
    entries: () => serial(() => [...operations.values()].map(copy)),
    claimIngress: (value) => serial(async () => {
      const messageId = identifier(value?.messageId || value?.id, 'ingress message ID');
      if (!messageId || (value.ownerUserId || value.authorId || value.author?.id) !== directMessageOwnerId) throw new Error('Only owner ingress can be journaled');
      if ((value.channelId || value.channel_id || channelId) !== channelId) throw new Error('Ingress belongs to a different channel');
      const existing = ingress.get(messageId);
      if (existing) return { claimed: false, entry: copy(existing) };
      pruneIngress();
      requireCapacity(ingress);
      const guildId = identifier(value.guildId || value.guild_id, 'ingress guild ID');
      const entry = { messageId, ownerUserId: directMessageOwnerId, channelId, ...(guildId ? { guildId } : {}), createdAt: now(), updatedAt: now(), status: 'running' };
      ingress.set(messageId, entry);
      await save();
      return { claimed: true, entry: copy(entry) };
    }),
    finishIngress: (messageId, outcome) => serial(async () => {
      identifier(messageId, 'ingress message ID');
      const existing = ingress.get(messageId);
      if (!existing) throw new Error('Ingress was not claimed');
      const selected = typeof outcome === 'string' ? outcome : outcome?.status;
      if (!['sent', 'skipped', 'failed', 'cancelled'].includes(selected)) throw new Error('Invalid ingress outcome');
      const entry = { ...existing, status: 'completed', outcome: selected, updatedAt: now() };
      ingress.set(messageId, entry);
      await save();
      return copy(entry);
    }),
    pendingIngress: () => serial(() => [...ingress.values()].filter((entry) => entry.status !== 'completed').map(copy)),
    close: async () => { closing = true; await sequence.catch(() => {}); await releaseLease(); },
  };
}

export async function createDeliveryJournal({ accountId, channelId, root = join(homedir(), '.local', 'share', 'discord-mcp', 'delivery'), now = Date.now } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId || '')) throw new Error('Invalid journal account ID');
  assertSnowflake(channelId, 'journal channel ID');
  const directory = resolvePath(root);
  const key = join(directory, `${accountId}-${channelId}.json`);
  let shared = openJournals.get(key);
  if (shared?.closing) { await shared.closing; return createDeliveryJournal({ accountId, channelId, root: directory, now }); }
  if (!shared) {
    shared = { references: 0, opening: openJournal({ accountId, channelId, root: directory, now }) };
    openJournals.set(key, shared);
  }
  shared.references += 1;
  let journal;
  try { journal = await shared.opening; }
  catch (error) { shared.references -= 1; if (openJournals.get(key) === shared) openJournals.delete(key); throw error; }
  let closed = false;
  const wrapper = Object.fromEntries(Object.entries(journal).filter(([name]) => name !== 'close').map(([name, method]) => [name, (...args) => closed ? Promise.reject(new Error('Delivery journal has closed')) : method(...args)]));
  wrapper.close = async () => {
    if (closed) return;
    closed = true;
    shared.references -= 1;
    if (!shared.references) {
      shared.closing = journal.close();
      await shared.closing;
      if (openJournals.get(key) === shared) openJournals.delete(key);
    }
  };
  return wrapper;
}
