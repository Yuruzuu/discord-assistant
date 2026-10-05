import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from './app-server.mjs';

const pools = new Map();
const spawnIdentities = new WeakMap();
let nextSpawnIdentity = 0;

export async function acquireCodexServer({ command, env, spawnImpl, onNotification, onToolCall, onFailure }) {
  if (spawnImpl && !spawnIdentities.has(spawnImpl)) spawnIdentities.set(spawnImpl, ++nextSpawnIdentity);
  const key = JSON.stringify([command, env, spawnImpl ? spawnIdentities.get(spawnImpl) : null]);
  let entry = pools.get(key);
  if (!entry || entry.server?.isClosed()) {
    entry = { owners: new Set(), threads: new Map() };
    pools.set(key, entry);
    entry.ready = (async () => {
      entry.directory = await mkdtemp(join(tmpdir(), 'nova-codex-pool-'));
      entry.server = createAppServer({ command, cwd: entry.directory, env, spawnImpl,
        onNotification: (method, parameters) => entry.threads.get(parameters?.threadId)?.onNotification(method, parameters),
        onToolCall: (parameters) => entry.threads.get(parameters?.threadId)?.onToolCall(parameters) || {
          success: false, contentItems: [{ type: 'inputText', text: 'This conversation is not active.' }],
        },
        onFailure: (error, parameters) => {
          if (parameters?.threadId) entry.threads.get(parameters.threadId)?.onFailure(error);
          else for (const owner of entry.owners) owner.onFailure(error);
        },
      });
      await entry.server.request('initialize', { clientInfo: { name: 'nova-discord', title: 'Nova Discord', version: '2.10.0' }, capabilities: { experimentalApi: true } });
      entry.server.notify('initialized');
    })();
  }
  const owner = { onNotification, onToolCall, onFailure, threadId: null };
  entry.owners.add(owner);
  try { await entry.ready; }
  catch (error) {
    entry.owners.delete(owner);
    if (!entry.owners.size) {
      if (pools.get(key) === entry) pools.delete(key);
      await entry.server?.close();
      if (entry.directory) await rm(entry.directory, { recursive: true, force: true });
    }
    throw error;
  }
  let released = false;
  return {
    async request(method, parameters, timeoutMs) {
      if (released) throw new Error('The Codex conversation is stopped');
      const result = await entry.server.request(method, parameters, timeoutMs);
      if (method === 'thread/start') {
        owner.threadId = result.thread.id;
        entry.threads.set(owner.threadId, owner);
      }
      return result;
    },
    isClosed: () => released || entry.server.isClosed(),
    peers: () => entry.owners.size,
    async close() {
      if (released) return;
      released = true;
      if (owner.threadId) {
        entry.threads.delete(owner.threadId);
        await entry.server.request('thread/unsubscribe', { threadId: owner.threadId }, 2000).catch(() => {});
      }
      entry.owners.delete(owner);
      if (!entry.owners.size) {
        if (pools.get(key) === entry) pools.delete(key);
        await entry.server.close();
        await rm(entry.directory, { recursive: true, force: true });
      }
    },
  };
}
