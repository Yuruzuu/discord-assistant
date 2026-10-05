import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './state.mjs';
import { directMessageOwnerId } from './target.mjs';
import { acquireScheduleLease } from './schedule-lease.mjs';

const terminal = new Set(['completed', 'failed', 'declined', 'expired', 'unknown']);
const protectedStates = new Set(['pending', 'executing', 'unknown']);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeText = (value) => String(value).replace(/```/g, 'ˋˋˋ').replace(/\u0000/g, '').slice(0, 1500);
function owner(userId) { if (userId !== directMessageOwnerId) throw new Error('Only the owner can approve actions'); }
function noCredentials(value, depth = 0) {
  if (depth > 16) throw new Error('Action arguments are too deeply nested');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:password|secret|token|api[_-]?key|authorization|cookie|credential)/i.test(key)) throw new Error('Action arguments must not include credentials');
    noCredentials(child, depth + 1);
  }
}

export function formatOwnerAction(action) {
  const body = JSON.stringify(action.request, null, 2);
  if (body.length > 1500) return `Approval ${action.id}: ${safeText(action.title)}\nThe full proposal is attached. Approve only after reviewing it.`;
  return `Approval ${action.id}: ${safeText(action.title)}\n\`\`\`json\n${safeText(body)}\n\`\`\`\nExpires <t:${Math.floor(action.expiresAt / 1000)}:R>. Approving runs this exact action once.`;
}

// Proposals are immutable, owner-DM-bound, and journaled before execution. Unknown outcomes never run again.
export function createOwnerActions({ accountId, channelId, execute, deliver, root = join(homedir(), '.local', 'share', 'discord-mcp', 'approvals'), now = Date.now, ttlMs = 30 * 60000 }) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId || '') || !/^\d{17,20}$/.test(channelId || '') || typeof execute !== 'function' || typeof deliver !== 'function') throw new Error('Action approvals require an owner DM and execution callbacks');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000) throw new Error('Approval expiry must be within one day');
  const filename = join(root, `${accountId}-${channelId}.json`);
  const actions = new Map();
  const active = new Set();
  let writes = Promise.resolve();
  let closed = false;
  let closing;
  let releaseLease;
  const snapshot = (action) => structuredClone(action);
  function expire() {
    let changed = false;
    for (const action of actions.values()) if (action.state === 'pending' && action.expiresAt <= now()) { action.state = 'expired'; changed = true; }
    return changed;
  }
  function prune() {
    expire();
    for (const [id, action] of actions) if (!protectedStates.has(action.state) && now() - action.createdAt > 7 * 86400000) actions.delete(id);
    const removable = [...actions.values()].filter((action) => !protectedStates.has(action.state)).sort((left, right) => left.createdAt - right.createdAt);
    for (const action of removable) { if (actions.size <= 100) break; actions.delete(action.id); }
    if (actions.size > 100) throw new Error('Resolve uncertain approvals before preparing more');
  }
  function persist() {
    prune();
    const data = JSON.stringify({ version: 1, ownerUserId: directMessageOwnerId, accountId, channelId, actions: [...actions.values()] });
    const operation = writes.catch(() => {}).then(() => writeFileAtomic(filename, data));
    writes = operation;
    operation.catch(() => { void close().catch(() => {}); });
    return operation;
  }
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    releaseLease = await acquireScheduleLease(filename);
    try {
      let stored;
      try { stored = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stored) {
        if (stored.version !== 1 || stored.ownerUserId !== directMessageOwnerId || (stored.accountId !== undefined && stored.accountId !== accountId) || stored.channelId !== channelId || !Array.isArray(stored.actions) || stored.actions.length > 100) throw new Error('Invalid owner action journal');
        for (const action of stored.actions) {
          if (!/^[a-f0-9-]{36}$/.test(action.id || '') || actions.has(action.id) || action.hash !== digest(action.request) || ![...terminal, 'pending', 'executing'].includes(action.state) || !Number.isFinite(action.createdAt) || !Number.isFinite(action.expiresAt) || typeof action.title !== 'string' || action.title.length > 200 || !['app', 'reminder', 'alert', 'handoff'].includes(action.request?.kind)) throw new Error('Invalid saved action proposal');
          noCredentials(action.request);
          if (action.state === 'executing') action.state = 'unknown';
          actions.set(action.id, action);
        }
      }
      await persist();
    } catch (error) {
      const release = releaseLease; releaseLease = null; await release?.(); throw error;
    }
  })();

  function tracked(task) {
    if (closed) return Promise.reject(new Error('Owner action manager has stopped'));
    const operation = (async () => { await ready; if (closed) throw new Error('Owner action manager has stopped'); return task(); })();
    active.add(operation);
    operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  }

  async function prepare({ userId, title, request }, signal) {
    owner(userId); signal?.throwIfAborted();
    if (!request || typeof request !== 'object' || !['app', 'reminder', 'alert', 'handoff'].includes(request.kind)) throw new Error('Unsupported action proposal');
    const copied = JSON.parse(JSON.stringify(request));
    if (JSON.stringify(copied).length > 16000) throw new Error('Action proposal exceeds 16000 characters');
    noCredentials(copied);
    prune();
    if ([...actions.values()].filter((action) => !terminal.has(action.state)).length >= 20) throw new Error('Resolve pending approvals before preparing more');
    if ([...actions.values()].filter((action) => protectedStates.has(action.state)).length >= 100) throw new Error('Resolve uncertain approvals before preparing more');
    const action = { id: randomUUID(), title: String(title || copied.kind).slice(0, 200), request: copied, hash: digest(copied), state: 'pending', createdAt: now(), expiresAt: now() + ttlMs };
    actions.set(action.id, action); await persist();
    try { if (closed) throw new Error('Owner action manager has stopped'); await deliver(snapshot(action), signal); }
    catch (error) { action.state = 'declined'; await persist(); throw error; }
    return { id: action.id, state: action.state, expiresAt: action.expiresAt, nextStep: 'The owner must approve the exact proposal in this DM. It has not executed.' };
  }

  async function decide({ userId, id, decision, channelId: sourceChannel = channelId }, signal) {
    owner(userId);
    if (sourceChannel !== channelId) throw new Error('Approval belongs to a different DM');
    const action = actions.get(id);
    if (!action || action.state !== 'pending') throw new Error('Approval is missing, resolved or has an unknown outcome; it cannot execute again');
    if (action.expiresAt <= now()) { action.state = 'expired'; await persist(); throw new Error('Approval expired'); }
    if (!['approve', 'decline'].includes(decision)) throw new Error('Choose approve or decline');
    if (action.hash !== digest(action.request)) throw new Error('Proposal changed; create a new approval');
    signal?.throwIfAborted();
    if (decision === 'decline') { action.state = 'declined'; await persist(); return { id, state: action.state }; }
    action.state = 'executing'; await persist();
    try {
      signal?.throwIfAborted();
      if (closed) throw Object.assign(new Error('Owner action manager has stopped'), { approvalRejected: true });
      const result = await execute(structuredClone(action.request), { signal, approvalId: action.id });
      action.state = result?.isError ? 'failed' : 'completed'; await persist();
      return { id, state: action.state, result };
    } catch (error) {
      action.state = error.sendStatus === 'rejected' || error.approvalRejected === true ? 'failed' : 'unknown';
      await persist();
      throw new Error(`Action ${action.state === 'unknown' ? 'has an unknown outcome; verify it in the app before preparing another' : 'was rejected'}.`, { cause: error });
    }
  }
  async function list({ userId }) { owner(userId); if (expire()) await persist(); return [...actions.values()].map(snapshot); }
  function close() {
    closed = true;
    if (!closing) closing = (async () => {
      await ready.catch(() => {}); await Promise.allSettled([...active]); await writes.catch(() => {});
      const release = releaseLease; releaseLease = null; await release?.();
    })();
    return closing;
  }
  return { ready, prepare: (...args) => tracked(() => prepare(...args)), decide: (...args) => tracked(() => decide(...args)), list: (...args) => tracked(() => list(...args)), close };
}
