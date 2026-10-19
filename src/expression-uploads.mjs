import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import { detectImageMime } from './discord-api.mjs';
import { assertSnowflake } from './discord-url.mjs';
import { assertReason, createResource } from './guild-admin.mjs';
import { markSendStatus } from './messaging.mjs';
import { shapeEmoji, shapeSticker } from './shapes.mjs';

// Discord's upload limits: emojis 256 KiB (PNG, JPEG, GIF, WebP), stickers 512 KiB (PNG, APNG, GIF; Lottie is partner-only).
export const EXPRESSION_KINDS = {
  emoji: { label: 'Emoji', maxBytes: 256 * 1024, extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp'], mimeTypes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']) },
  sticker: { label: 'Sticker', maxBytes: 512 * 1024, extensions: ['.png', '.apng', '.gif'], mimeTypes: new Set(['image/png', 'image/gif']) },
};
const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;
const IMPORT_LIMIT = 50;
// Missing permissions or a full emoji/sticker slot list fail every later upload the same way, so a folder import stops there.
const STOP_CODES = new Set([50013, 30008, 30039]);

function kindSpec(kind) {
  if (!Object.hasOwn(EXPRESSION_KINDS, kind)) throw new Error('kind must be emoji or sticker');
  return EXPRESSION_KINDS[kind];
}

export function localPath(path, field = 'filePath') {
  if (typeof path !== 'string' || !path.trim() || path.length > 4096) throw new Error(`${field} must be a non-empty path`);
  const expanded = path === '~' || /^~[\\/]/.test(path) ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded)) throw new Error(`${field} must be an absolute path on this computer (or start with ~)`);
  return expanded;
}

export function expressionName(filename, kind) {
  const stem = basename(filename, extname(filename));
  return kind === 'emoji' ? stem.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) : stem.trim().slice(0, 30);
}

function nameProblem(name, kind) {
  if (kind === 'emoji') return typeof name === 'string' && EMOJI_NAME.test(name) ? null : 'Emoji names must be 2 to 32 letters, numbers or underscores';
  return typeof name === 'string' && name.trim().length >= 2 && name.length <= 30 ? null : 'Sticker names must be 2 to 30 characters';
}

function assertStickerText({ description, tags }) {
  if (description !== undefined && (typeof description !== 'string' || description.length === 1 || description.length > 100)) throw new Error('description must be empty or 2 to 100 characters');
  if (tags !== undefined && (typeof tags !== 'string' || !tags.trim() || tags.length > 200)) throw new Error('tags must be 1 to 200 characters');
}

function checkImage(bytes, kind) {
  const spec = kindSpec(kind);
  if (!bytes.length || bytes.length > spec.maxBytes) throw new Error(`${spec.label} images must be at most ${spec.maxBytes / 1024} KiB (this one is ${Math.ceil(bytes.length / 1024)} KiB)`);
  const mimeType = detectImageMime(bytes);
  if (!spec.mimeTypes.has(mimeType)) throw new Error(`${spec.label} images must be ${spec.extensions.join(', ')} files; the contents are ${mimeType || 'not a supported image'}`);
  return { bytes, mimeType, name: `${kind}.${mimeType.split('/')[1].replace('jpeg', 'jpg')}` };
}

// Size and type are checked before the whole file is read, so a mistaken path to a large or unrelated file is refused cheaply.
export async function readLocalImage(path, kind) {
  const spec = kindSpec(kind);
  const filename = localPath(path);
  if (!spec.extensions.includes(extname(filename).toLowerCase())) throw new Error(`${spec.label} files must end in ${spec.extensions.join(', ')}`);
  const info = await stat(filename);
  if (!info.isFile()) throw new Error(`${basename(filename)} is not a file`);
  if (info.size > spec.maxBytes) throw new Error(`${spec.label} images must be at most ${spec.maxBytes / 1024} KiB (${basename(filename)} is ${Math.ceil(info.size / 1024)} KiB)`);
  return checkImage(await readFile(filename), kind);
}

async function sourceImage(account, { filePath, imageUrl }, kind) {
  if (filePath !== undefined) return readLocalImage(filePath, kind);
  const image = await account.client.fetchImage(imageUrl, { maxBytes: kindSpec(kind).maxBytes });
  return checkImage(Buffer.from(image.data, 'base64'), kind);
}

function assertSource({ filePath, imageUrl, name }) {
  if ((filePath === undefined) === (imageUrl === undefined)) throw new Error('Provide exactly one of filePath or imageUrl');
  if (imageUrl !== undefined && name === undefined) throw new Error('name is required when uploading from imageUrl');
}

function postExpression(account, guildId, kind, { name, description = '', tags }, image, { signal, reason }) {
  signal?.throwIfAborted();
  if (kind === 'emoji') return account.client.createGuildEmoji(guildId, { name, image: `data:${image.mimeType};base64,${image.bytes.toString('base64')}` }, { signal, reason });
  return account.client.createGuildSticker(guildId, { name, description, tags: tags ?? name, file: image }, { signal, reason });
}

function shapeExpression(kind, guildId, created) {
  return kind === 'emoji' ? { emoji: shapeEmoji(created) } : { sticker: shapeSticker({ ...created, guild_id: created.guild_id || guildId }) };
}

async function createExpression(service, kind, { guildId, name, filePath, imageUrl, description, tags, reason }, { signal } = {}) {
  assertSnowflake(guildId, 'guildId');
  assertReason(reason);
  assertSource({ filePath, imageUrl, name });
  if (kind === 'sticker') assertStickerText({ description, tags });
  const expressionNameValue = name ?? expressionName(localPath(filePath), kind);
  const problem = nameProblem(expressionNameValue, kind);
  if (problem) throw new Error(name === undefined ? `${problem}; pass name because "${basename(filePath)}" does not make one` : problem);

  const local = filePath === undefined ? null : await readLocalImage(filePath, kind);
  signal?.throwIfAborted();
  const { account } = await service.resolveGuild(guildId);
  const image = local || await sourceImage(account, { imageUrl }, kind);
  const created = await createResource(() => postExpression(account, guildId, kind, { name: expressionNameValue, description, tags }, image, { signal, reason }), kind);

  return { accountId: account.id, guildId, ...shapeExpression(kind, guildId, created) };
}

export function createEmoji(service, args, options) {
  return createExpression(service, 'emoji', args, options);
}

export function createSticker(service, args, options) {
  return createExpression(service, 'sticker', args, options);
}

export async function importExpressionFolder(service, { guildId, folderPath, kind = 'emoji', tags, description, skipExisting = true, dryRun = false, limit = IMPORT_LIMIT, reason }, { signal } = {}) {
  assertSnowflake(guildId, 'guildId');
  assertReason(reason);
  const spec = kindSpec(kind);
  if (kind === 'sticker') assertStickerText({ description, tags });
  if (!Number.isInteger(limit) || limit < 1 || limit > IMPORT_LIMIT) throw new Error(`limit must be an integer from 1 to ${IMPORT_LIMIT}`);
  const folder = localPath(folderPath, 'folderPath');
  const files = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && spec.extensions.includes(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!files.length) throw new Error(`No ${spec.extensions.join(', ')} files found directly inside ${folder}`);

  signal?.throwIfAborted();
  const { account } = await service.resolveGuild(guildId);
  const taken = new Set(skipExisting ? (await account.client[kind === 'emoji' ? 'listGuildEmojis' : 'listGuildStickers'](guildId)).map((item) => item.name?.toLowerCase()) : []);
  const created = [], planned = [], skipped = [], failed = [];
  let stopped = null, index = 0;

  for (; index < files.length && !stopped; index += 1) {
    const file = files[index];
    const name = expressionName(file, kind);
    const problem = nameProblem(name, kind);
    if (problem) { skipped.push({ file, name, reason: problem }); continue; }
    if (taken.has(name.toLowerCase())) { skipped.push({ file, name, reason: skipExisting ? 'A server expression or earlier file already uses this name' : 'An earlier file already uses this name' }); continue; }
    if (created.length + planned.length >= limit) break;
    let image;
    try { image = await readLocalImage(join(folder, file), kind); } catch (error) { skipped.push({ file, name, reason: error.message }); continue; }
    taken.add(name.toLowerCase());
    if (dryRun) { planned.push({ file, name, bytes: image.bytes.length, mimeType: image.mimeType }); continue; }
    try {
      created.push({ file, ...shapeExpression(kind, guildId, await postExpression(account, guildId, kind, { name, description, tags }, image, { signal, reason })) });
    } catch (error) {
      if (signal?.aborted) throw error;
      markSendStatus(error);
      failed.push({ file, name, error: error.message, status: error.status ?? null, code: error.code ?? null, sendStatus: error.sendStatus });
      if (error.sendStatus === 'unknown') stopped = `The outcome for ${file} is unknown; it may have been created. Run again with skipExisting to continue safely.`;
      else if (STOP_CODES.has(error.code) || error.status === 403) stopped = `Stopped: ${error.message}`;
    }
  }

  return {
    accountId: account.id, guildId, kind, folder, dryRun,
    ...(dryRun ? { wouldCreate: planned } : { created }),
    skipped, failed, notAttempted: files.slice(index), ...(stopped ? { stopped } : {}),
  };
}
