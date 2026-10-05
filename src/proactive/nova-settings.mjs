import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { directMessageOwnerId } from './target.mjs';
import { writeFileAtomic } from './state.mjs';

const conversationSchema = z.object({
  model: z.string().min(1).max(128).optional(), reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  serviceTier: z.enum(['priority', 'default']).optional(), timeoutMs: z.number().int().min(1000).max(900000).optional(),
  toolTimeoutMs: z.number().int().min(1000).max(120000).optional(), maxToolCalls: z.number().int().min(1).max(100).optional(),
  paused: z.boolean().optional(),
}).strict();
const settingsSchema = z.object({
  version: z.literal(1).default(1),
  projectRoots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), name: z.string().max(100).optional(), root: z.string().refine(isAbsolute) }).strict()).max(20).default([]),
  voice: z.object({ backend: z.enum(['disabled', 'local', 'api']).default('disabled'), executable: z.string().optional(), model: z.string().optional(), ffmpeg: z.string().optional(),
    endpoint: z.string().url().optional(), apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional() }).strict().default({ backend: 'disabled' }),
  conversations: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,40}:\d{17,20}$/), conversationSchema).default({}),
  web: z.boolean().default(true), media: z.boolean().default(true), playbooks: z.boolean().default(true), apps: z.boolean().default(true), timeZone: z.string().max(64).optional(), webSearch: z.enum(['auto', 'live', 'cached', 'indexed', 'disabled']).default('auto'),
}).strict();

export function novaSettingsPath() { return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'discord-mcp', 'nova.json'); }

export function createNovaSettings({ filename = novaSettingsPath() } = {}) {
  let writes = Promise.resolve();
  function conversationFile(accountId, channelId) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(accountId) || !/^\d{17,20}$/.test(channelId)) throw new Error('Invalid conversation settings target');
    return join(dirname(filename), 'nova-conversations', `${accountId}-${channelId}.json`);
  }
  async function load(accountId, channelId) {
    let value;
    try { value = settingsSchema.parse(JSON.parse(await readFile(filename, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') value = settingsSchema.parse({}); else throw new Error('Nova settings are invalid. Check the private nova.json configuration.'); }
    if (accountId && channelId) {
      try { value.conversations[`${accountId}:${channelId}`] = conversationSchema.parse(JSON.parse(await readFile(conversationFile(accountId, channelId), 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Nova conversation settings are invalid'); }
    }
    return value;
  }
  async function save(value, userId) {
    if (userId !== directMessageOwnerId) throw new Error('Only the owner can change Nova settings');
    const parsed = settingsSchema.parse(value);
    return serialize(async () => {
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      await writeFileAtomic(filename, JSON.stringify(parsed, null, 2) + '\n');
      return parsed;
    });
  }
  async function configureConversation(accountId, channelId, patch, userId) {
    if (userId !== directMessageOwnerId) throw new Error('Only the owner can change Nova settings');
    const target = conversationFile(accountId, channelId);
    return serialize(async () => {
      const value = await load(accountId, channelId);
      const selected = { ...value.conversations[`${accountId}:${channelId}`], ...conversationSchema.parse(patch) };
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFileAtomic(target, JSON.stringify(selected));
      return selected;
    });
  }
  function serialize(task) {
    const operation = writes.catch(() => {}).then(task);
    writes = operation;
    return operation;
  }
  return { load, save, configureConversation, filename };
}
