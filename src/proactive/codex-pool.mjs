import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from './app-server.mjs';

const pools = new Map();
const spawnIdentities = new WeakMap();
let nextSpawnIdentity = 0;

function stoppedError(message = 'The Codex conversation is stopped') {
  return Object.assign(new Error(message), { code: 'CODEX_REQUEST_ABORTED', writeOutcome: 'not-written' });
}

function waitForStartup(ready, signal) {
  if (!signal) return ready;
  if (signal.aborted) return Promise.reject(stoppedError('Codex worker startup cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(stoppedError('Codex worker startup cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    ready.then((result) => { signal.removeEventListener('abort', abort); resolve(result); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export async function acquireCodexServer({ command, env, spawnImpl, onNotification, onToolCall, onFailure = () => {}, onLateResponse = () => {}, signal }) {
  signal?.throwIfAborted();
  if (spawnImpl && !spawnIdentities.has(spawnImpl)) spawnIdentities.set(spawnImpl, ++nextSpawnIdentity);
  const key = JSON.stringify([command, Object.entries(env || {}).sort(([left], [right]) => left.localeCompare(right)), spawnImpl ? spawnIdentities.get(spawnImpl) : null]);
  let entry = pools.get(key);
  if (!entry || entry.server?.isClosed() || entry.retiring) {
    entry = { owners: new Set(), threads: new Map(), retiring: false };
    pools.set(key, entry);
    entry.ready = (async () => {
      entry.directory = await mkdtemp(join(tmpdir(), 'nova-codex-pool-'));
      if (entry.retiring) throw stoppedError('Codex startup has no remaining owners');
      entry.server = createAppServer({ command, cwd: entry.directory, env, spawnImpl,
        onNotification: (method, parameters) => entry.threads.get(parameters?.threadId)?.onNotification?.(method, parameters),
        onToolCall: (parameters) => entry.threads.get(parameters?.threadId)?.onToolCall?.(parameters) || {
          success: false, contentItems: [{ type: 'inputText', text: 'This conversation is not active.' }],
        },
        onFailure: (error, parameters) => {
          if (parameters?.threadId) entry.threads.get(parameters.threadId)?.onFailure(error);
          else for (const owner of entry.owners) owner.onFailure(error);
        },
      });
      await entry.server.request('initialize', { clientInfo: { name: 'nova-discord', title: 'Nova Discord', version: '2.11.0' }, capabilities: { experimentalApi: true } });
      await entry.server.notify('initialized');
    })();
  }
  const owner = { onNotification, onToolCall, onFailure, onLateResponse, threadId: null, retired: false };
  entry.owners.add(owner);
  let released = false;

  function retireEntryIfEmpty() {
    if (entry.owners.size || entry.retiring) return;
    entry.retiring = true;
    if (pools.get(key) === entry) pools.delete(key);
    entry.cleanup = entry.ready.catch(() => {}).then(async () => {
      await entry.server?.close();
      if (entry.directory) await rm(entry.directory, { recursive: true, force: true });
    });
    void entry.cleanup.catch(() => {});
  }

  async function disposeThread(threadId) {
    if (!threadId || entry.server?.isClosed()) return;
    await entry.server.request('thread/unsubscribe', { threadId }, 2000).catch(() => {});
  }

  async function receiveLate(response, callerCallback) {
    // A written start may create native work after its caller has abandoned it.
    // It is never replayed; stop that orphan using the identity from the reply.
    try { await (callerCallback || owner.onLateResponse)(response); }
    finally {
      if (response.method === 'turn/start' && response.result?.turn?.id && response.params?.threadId) {
        await entry.server.request('turn/interrupt', { threadId: response.params.threadId, turnId: response.result.turn.id }, 5000).catch(() => {});
      }
      if (response.method === 'thread/start' && response.result?.thread?.id) await disposeThread(response.result.thread.id);
    }
  }

  try { await waitForStartup(entry.ready, signal); }
  catch (error) {
    released = true;
    entry.owners.delete(owner);
    retireEntryIfEmpty();
    throw error;
  }

  return {
    async request(method, parameters, options) {
      if (released || owner.retired) throw stoppedError();
      if (parameters?.threadId && parameters.threadId !== owner.threadId) throw stoppedError('Codex request belongs to a different conversation');
      if (method === 'thread/start' && owner.threadId) throw stoppedError('Codex conversation already owns a thread');
      const settings = typeof options === 'number' ? { timeoutMs: options } : options || {};
      const result = await entry.server.request(method, parameters, { ...settings, onLateResponse: (response) => receiveLate(response, settings.onLateResponse) });
      if (method === 'thread/start') {
        if (!result?.thread?.id || typeof result.thread.id !== 'string') throw new Error('Codex thread/start returned no valid thread identity');
        if (released || owner.retired) {
          await disposeThread(result.thread.id);
          throw stoppedError();
        }
        if (entry.threads.has(result.thread.id)) throw new Error('Codex returned an already owned thread identity');
        owner.threadId = result.thread.id;
        entry.threads.set(owner.threadId, owner);
      }
      return result;
    },
    isClosed: () => released || owner.retired || entry.server.isClosed(),
    peers: () => entry.owners.size,
    async retireThread() {
      if (owner.retired) return;
      owner.retired = true;
      if (owner.threadId) {
        const threadId = owner.threadId;
        owner.threadId = null;
        entry.threads.delete(threadId);
        await disposeThread(threadId);
      }
    },
    async close() {
      if (released) return;
      released = true;
      if (owner.threadId) {
        entry.threads.delete(owner.threadId);
        await disposeThread(owner.threadId);
      }
      entry.owners.delete(owner);
      retireEntryIfEmpty();
      if (entry.cleanup) await entry.cleanup;
    },
  };
}
