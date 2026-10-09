import { assertSnowflake } from './discord-url.mjs';
import { markSendStatus } from './messaging.mjs';
import { shapeChannel } from './shapes.mjs';

export const CREATABLE_CHANNEL_TYPES = { text: 0, voice: 2, announcement: 5, stage: 13, forum: 15 };
const CATEGORY_TYPE = 4;
const NAME_LIMIT = 100;

function assertName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > NAME_LIMIT) throw new Error(`name must be 1 to ${NAME_LIMIT} characters`);
}

function assertReason(reason) {
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 512)) throw new Error('reason must be a string of at most 512 characters');
}

export function normalizeRoleColor(color) {
  if (color === undefined) return undefined;
  const value = typeof color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(color) ? Number.parseInt(color.replace('#', ''), 16) : color;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new Error('color must be an integer from 0 to 16777215 or a #RRGGBB hex string');
  return value;
}

// Creates are POSTs and are never retried, so a failure without a 4xx answer may already have been applied; callers must check before repeating it.
async function createResource(call, noun) {
  try {
    return await call();
  } catch (error) {
    if (markSendStatus(error).sendStatus === 'unknown') error.message += ` The ${noun} may have been created; list the server before retrying.`;
    throw error;
  }
}

async function postChannel(service, { guildId, payload, reason }, signal) {
  signal?.throwIfAborted();
  const { account } = await service.resolveGuild(guildId);
  signal?.throwIfAborted();
  const channel = await createResource(() => account.client.createGuildChannel(guildId, payload, { signal, reason }), 'channel');

  return { accountId: account.id, channel: shapeChannel({ ...channel, guild_id: channel.guild_id || guildId }) };
}

export async function createChannel(service, { guildId, name, type = 'text', parentId, topic, nsfw, userLimit, rateLimitPerUser, reason }, { signal } = {}) {
  assertSnowflake(guildId, 'guildId');
  assertName(name);
  assertReason(reason);
  if (!Object.hasOwn(CREATABLE_CHANNEL_TYPES, type)) throw new Error(`type must be one of ${Object.keys(CREATABLE_CHANNEL_TYPES).join(', ')}`);
  if (parentId) assertSnowflake(parentId, 'parentId');
  if (topic !== undefined && (typeof topic !== 'string' || topic.length > 1024)) throw new Error('topic must be a string of at most 1024 characters');
  if (userLimit !== undefined && (!Number.isInteger(userLimit) || userLimit < 0 || userLimit > 99)) throw new Error('userLimit must be an integer from 0 to 99');
  if (rateLimitPerUser !== undefined && (!Number.isInteger(rateLimitPerUser) || rateLimitPerUser < 0 || rateLimitPerUser > 21600)) throw new Error('rateLimitPerUser must be an integer from 0 to 21600 seconds');

  return postChannel(service, {
    guildId, reason,
    payload: {
      name, type: CREATABLE_CHANNEL_TYPES[type],
      ...(parentId ? { parent_id: parentId } : {}),
      ...(topic === undefined ? {} : { topic }),
      ...(nsfw === undefined ? {} : { nsfw }),
      ...(userLimit === undefined ? {} : { user_limit: userLimit }),
      ...(rateLimitPerUser === undefined ? {} : { rate_limit_per_user: rateLimitPerUser }),
    },
  }, signal);
}

export async function createCategory(service, { guildId, name, reason }, { signal } = {}) {
  assertSnowflake(guildId, 'guildId');
  assertName(name);
  assertReason(reason);

  return postChannel(service, { guildId, reason, payload: { name, type: CATEGORY_TYPE } }, signal);
}

export function shapeRole(role) {
  return {
    id: role.id, name: role.name, color: role.color ?? 0, hoist: Boolean(role.hoist), mentionable: Boolean(role.mentionable),
    managed: Boolean(role.managed), position: role.position ?? null, permissions: role.permissions ?? null,
  };
}

export async function createRole(service, { guildId, name, color, hoist, mentionable, permissions, reason }, { signal } = {}) {
  assertSnowflake(guildId, 'guildId');
  assertName(name);
  assertReason(reason);
  const roleColor = normalizeRoleColor(color);
  if (permissions !== undefined && (typeof permissions !== 'string' || !/^\d{1,20}$/.test(permissions))) throw new Error('permissions must be a decimal permission bitfield string');

  signal?.throwIfAborted();
  const { account } = await service.resolveGuild(guildId);
  signal?.throwIfAborted();
  const role = await createResource(() => account.client.createGuildRole(guildId, {
    name,
    ...(roleColor === undefined ? {} : { color: roleColor }),
    ...(hoist === undefined ? {} : { hoist }),
    ...(mentionable === undefined ? {} : { mentionable }),
    ...(permissions === undefined ? {} : { permissions }),
  }, { signal, reason }), 'role');

  return { accountId: account.id, guildId, role: shapeRole(role) };
}

async function changeMemberRole(service, { guildId, userId, roleId, reason }, action, signal) {
  assertSnowflake(guildId, 'guildId');
  assertSnowflake(userId, 'userId');
  assertSnowflake(roleId, 'roleId');
  assertReason(reason);
  if (roleId === guildId) throw new Error('The @everyone role cannot be assigned or removed');

  signal?.throwIfAborted();
  const { account } = await service.resolveGuild(guildId);
  signal?.throwIfAborted();
  await account.client[action](guildId, userId, roleId, { signal, reason });

  return { accountId: account.id, guildId, userId, roleId };
}

export async function addMemberRole(service, args, { signal } = {}) {
  return { ...await changeMemberRole(service, args, 'addGuildMemberRole', signal), assigned: true };
}

export async function removeMemberRole(service, args, { signal } = {}) {
  return { ...await changeMemberRole(service, args, 'removeGuildMemberRole', signal), removed: true };
}
