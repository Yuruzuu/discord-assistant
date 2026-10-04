import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { directMessageOwnerId } from './target.mjs';

export function proactiveRoot() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'discord-mcp', 'proactive');
}

export function listenerPaths(accountId, channelId, root = proactiveRoot()) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !/^\d{17,20}$/.test(channelId)) throw new Error('Invalid listener account or channel ID');

  return pathsForTarget(accountId, channelId, root);
}

export function directMessagePaths(accountId, root = proactiveRoot()) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId)) throw new Error('Invalid listener account ID');

  return pathsForTarget(accountId, `dm-${directMessageOwnerId}`, root);
}

export function serverMentionPaths(accountId, root = proactiveRoot()) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId)) throw new Error('Invalid listener account ID');
  return pathsForTarget(accountId, 'servers', root);
}

export function listenerTargetPaths({ accountId, channelId, directMessages, allServers }, root = proactiveRoot()) {
  if (directMessages && allServers) throw new Error('DM and all-server listeners must be separate');
  if (allServers) return serverMentionPaths(accountId, root);
  return directMessages ? directMessagePaths(accountId, root) : listenerPaths(accountId, channelId, root);
}

function pathsForTarget(accountId, target, root) {
  return {
    root,
    configuration: join(root, `${accountId}-${target}.json`),
    status: join(root, `${accountId}-${target}.status.json`),
    log: join(root, `${accountId}-${target}.log`),
  };
}

export async function readState(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Writes a private file by renaming a fully written temporary file into place.
export async function writeFileAtomic(filename, text) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, filename);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function writeState(filename, value) {
  await writeFileAtomic(filename, JSON.stringify(value));
}

export async function ensureStateRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
}
