import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function proactiveRoot() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'discord-mcp', 'proactive');
}

export function listenerPaths(accountId, channelId, root = proactiveRoot()) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !/^\d{17,20}$/.test(channelId)) throw new Error('Invalid listener account or channel ID');
  return {
    root,
    configuration: join(root, `${accountId}-${channelId}.json`),
    status: join(root, `${accountId}-${channelId}.status.json`),
    log: join(root, `${accountId}-${channelId}.log`),
  };
}

export async function readState(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeState(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, filename);
}

export async function ensureStateRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
}
