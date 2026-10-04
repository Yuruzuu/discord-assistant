import { z } from 'zod/v4';
import { searchMessages } from '../search.mjs';
import { browseMessages } from '../message-browser.mjs';
import { getUserInfo } from '../users.mjs';

export const readSnowflake = z.string().regex(/^\d{17,20}$/).describe('Discord snowflake ID');
const source = { url: z.string().url().optional(), guildId: readSnowflake.optional(), channelId: readSnowflake.optional(), messageId: readSnowflake.optional(), limit: z.number().int().min(1).max(250).default(50), includeImages: z.boolean().default(false) };
const sharedFields = {
  discord_list_servers: { refresh: z.boolean().default(false) },
  discord_list_channels: { guildId: readSnowflake, includeThreads: z.boolean().default(true), includeArchivedThreads: z.boolean().default(false), parentChannelIds: z.array(readSnowflake).default([]), maxArchivedPerParent: z.number().int().min(1).max(500).default(200) },
  discord_find_members: { guildId: readSnowflake, query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(100).default(25) },
  discord_search_messages: { guildId: readSnowflake, query: z.string().max(1024).default(''), channelIds: z.array(readSnowflake).max(500).default([]), authorIds: z.array(readSnowflake).max(100).default([]), mentionsUserIds: z.array(readSnowflake).max(100).default([]), repliedToMessageIds: z.array(readSnowflake).max(100).default([]), has: z.array(z.enum(['image', 'sound', 'video', 'file', 'sticker', 'embed', 'link', 'poll', 'snapshot'])).default([]), embedTypes: z.array(z.enum(['image', 'video', 'gif', 'sound', 'article'])).default([]), beforeId: readSnowflake.optional(), afterId: readSnowflake.optional(), pinned: z.boolean().optional(), includeNsfw: z.boolean().default(false), sortBy: z.enum(['timestamp', 'relevance']).default('timestamp'), sortOrder: z.enum(['asc', 'desc']).default('desc'), limit: z.number().int().min(1).max(250).default(250), offset: z.number().int().min(0).max(9975).default(0), accountId: z.string().optional() },
  discord_message_context: source,
  discord_browse_messages: { ...source, before: readSnowflake.optional(), after: readSnowflake.optional(), around: readSnowflake.optional(), limit: z.number().int().min(1).max(250).default(250) },
  discord_user_info: { guildId: readSnowflake.optional(), userId: readSnowflake, accountId: z.string().optional() },
};
const workerSearchFields = ['guildId', 'query', 'channelIds', 'authorIds', 'mentionsUserIds', 'beforeId', 'afterId', 'sortOrder', 'limit', 'offset'];
export function readToolFields(name, { trustedLocal = false } = {}) {
  const fields = sharedFields[name];
  if (!fields) return null;
  if (trustedLocal) return fields;
  if (name === 'discord_list_channels') return { guildId: fields.guildId, includeThreads: fields.includeThreads };
  if (name === 'discord_search_messages') return { ...Object.fromEntries(workerSearchFields.map((field) => [field, fields[field]])), channelIds: z.array(readSnowflake).max(100).default([]), limit: z.number().int().min(1).max(250).default(50) };
  if (name === 'discord_browse_messages') return { ...fields, limit: source.limit };
  if (name === 'discord_user_info') return { guildId: readSnowflake, userId: readSnowflake };
  return fields;
}

export async function executeSharedReadTool(service, name, args, signal) {
  signal?.throwIfAborted();
  if (name === 'discord_list_servers') return service.listServers(args);
  if (name === 'discord_list_channels') return service.listChannels(args);
  if (name === 'discord_search_messages') return searchMessages(service, args, { signal });
  if (name === 'discord_user_info') return getUserInfo(service, args);
  if (name === 'discord_find_members') {
    const { account } = await service.resolveGuild(args.guildId);
    const members = await account.client.searchGuildMembers(args.guildId, args.query, args.limit);
    if (!Array.isArray(members)) throw new Error('Discord returned an invalid member search result');
    return { guildId: args.guildId, members: members.map((member) => ({ id: member.user?.id, username: member.user?.username, displayName: member.user?.global_name || null, nickname: member.nick || null, bot: Boolean(member.user?.bot) })) };
  }
  if (['discord_message_context', 'discord_browse_messages'].includes(name)) {
    if (name === 'discord_message_context' && !service.normalizeReadSource(args).messageId) throw new Error('Provide a message URL or channelId and messageId');
    const result = await browseMessages(service, args, { signal });
    return { ...result.structured, toolImages: result.images };
  }
  throw new Error('Unknown shared read operation');
}
