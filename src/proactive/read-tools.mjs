import { z } from 'zod/v4';
import { searchMessages } from '../search.mjs';
import { browseMessages } from '../message-browser.mjs';
import { getUserInfo } from '../users.mjs';
import { assertOwnerDirectMessageChannel } from './target.mjs';

const snowflake = z.string().regex(/^\d{17,20}$/);
const sourceFields = {
  url: z.string().url().optional(), guildId: snowflake.optional(), channelId: snowflake.optional(),
  messageId: snowflake.optional(), limit: z.number().int().min(1).max(250).default(50),
};

export function createDiscordReadTools(service, scope) {
  const tools = new Map();

  function register(name, description, fields, execute) {
    const schema = z.strictObject(fields);
    tools.set(name, { schema, execute, spec: { type: 'function', name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }) } });
  }

  async function guild(guildId) {
    if (!scope.directMessages && guildId !== scope.guildId) throw new Error('Server conversations can only read their own server. Ask in your owner DM to research another server.');
    return service.resolveGuild(guildId);
  }

  async function channelSource(args) {
    const source = service.normalizeReadSource(args);
    const target = await service.resolveChannel(source.channelId, source.guildId);
    if (target.channel.guild_id) {
      if (source.guildId && source.guildId !== target.channel.guild_id) throw new Error('Channel does not belong to the supplied server');
      await guild(target.channel.guild_id);
    } else {
      if (!scope.directMessages || source.channelId !== scope.channelId || source.guildId) throw new Error('Only this owner DM is readable; other private conversations are unavailable.');
      assertOwnerDirectMessageChannel(target.channel);
    }
    return { ...source, guildId: target.channel.guild_id || null };
  }

  register('discord_list_servers', 'Find server IDs by name. Owner DMs can discover bot-accessible servers; server conversations see only their own server. Discovery errors do not mean there are zero servers.', {
    refresh: z.boolean().default(false),
  }, async (args) => {
    const result = await service.listServers(args);
    if (scope.directMessages) return result;
    return { servers: result.servers.filter((server) => server.id === scope.guildId),
      accounts: result.accounts.map(({ accountId, bot, error }) => ({ accountId, bot, error })),
      expectedMissing: (result.expectedMissing || []).filter((entry) => entry.guildId === scope.guildId) };
  });

  register('discord_list_channels', 'Find channel IDs and active threads by name in a permitted server. Resolve names before reading messages.', {
    guildId: snowflake, includeThreads: z.boolean().default(true),
  }, async (args) => { await guild(args.guildId); return service.listChannels(args); });

  register('discord_find_members', 'Resolve author IDs from username or server nickname prefixes, for example Valk or Shinsoku. Check returned matches instead of assuming an identity. This does not report presence.', {
    guildId: snowflake, query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(100).default(25),
  }, async ({ guildId, query, limit }) => {
    const { account } = await guild(guildId);
    const members = await account.client.searchGuildMembers(guildId, query, limit);
    if (!Array.isArray(members)) throw new Error('Discord returned an invalid member search result');
    return { guildId, members: members.map((member) => ({ id: member.user?.id, username: member.user?.username, displayName: member.user?.global_name || null, nickname: member.nick || null, bot: Boolean(member.user?.bot) })) };
  });

  register('discord_search_messages', 'Search indexed messages across accessible channels in a permitted server, up to 250 matches. Use authorIds from discord_find_members for author filters. Follow continuation arguments for more pages; open relevant hits with discord_message_context. Report indexing or access errors.', {
    guildId: snowflake, query: z.string().max(1024).default(''), channelIds: z.array(snowflake).max(100).default([]),
    authorIds: z.array(snowflake).max(100).default([]), mentionsUserIds: z.array(snowflake).max(100).default([]),
    beforeId: snowflake.optional(), afterId: snowflake.optional(), sortOrder: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(250).default(50), offset: z.number().int().min(0).max(9975).default(0),
  }, async (args, signal) => {
    const { account } = await guild(args.guildId);
    for (const channelId of args.channelIds) {
      signal?.throwIfAborted();
      const channel = await account.client.getChannel(channelId);
      if (channel.guild_id !== args.guildId) throw new Error('Search channel does not belong to the requested server');
    }
    const result = await searchMessages(service, { ...args, accountId: account.id }, { signal });
    if (result.continuation) {
      result.continuation = Object.fromEntries(Object.entries(result.continuation).filter(([name]) => Object.hasOwn(tools.get('discord_search_messages').schema.shape, name)));
    }
    return result;
  });

  async function browse(args, requireAnchor, signal) {
    const source = await channelSource(args);
    if (requireAnchor && !source.messageId) throw new Error('Provide a message URL or channelId and messageId');
    const result = await browseMessages(service, { ...args, ...source, url: undefined, includeImages: false }, { signal });
    return result.structured;
  }

  register('discord_message_context', 'Jump to a search result message URL or message ID and read nearby messages chronologically. Use returned older/newer navigation with discord_browse_messages to expand context.', sourceFields, (args, signal) => browse(args, true, signal));
  register('discord_browse_messages', 'Read or continue channel history using before/after cursors or an around anchor. Returns chronological messages and older/newer navigation, up to 250 messages per call. Other users personal DMs are unavailable.', {
    ...sourceFields, before: snowflake.optional(), after: snowflake.optional(), around: snowflake.optional(),
  }, (args, signal) => browse(args, false, signal));

  register('discord_user_info', 'Read a server member profile, nickname, avatar and roles by known user ID. Does not report presence or access their DMs.', {
    guildId: snowflake, userId: snowflake,
  }, async (args) => { const { account } = await guild(args.guildId); return getUserInfo(service, { ...args, accountId: account.id }); });

  async function call(name, argumentsValue, signal) {
    signal?.throwIfAborted();
    const tool = tools.get(name);
    if (!tool) throw new Error('This tool is unavailable. Nova only has the supplied Discord reading tools.');
    const args = tool.schema.parse(argumentsValue);
    const result = await tool.execute(args, signal);
    signal?.throwIfAborted();
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error('Too much message context. Retry with a smaller limit and follow the returned navigation.');
    return { contentItems: [{ type: 'inputText', text }], success: true,
      resultCount: result.messages?.length ?? result.members?.length ?? result.channels?.length ?? result.servers?.length };
  }

  function errorMessage(error) {
    let text = error instanceof z.ZodError ? 'Invalid Discord reading tool arguments. Follow the supplied tool schema.' : String(error.message);
    for (const account of service.accounts) if (account.token) text = text.replaceAll(account.token, '[redacted]');
    return text.slice(0, 500);
  }

  return { definitions: [...tools.values()].map((tool) => tool.spec), has: (name) => tools.has(name), call, errorMessage };
}
