import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { forwardMessages, listExpressions, sendMessage, sendMessageBatch } from './messaging.mjs';
import { register, success, writeAnnotations } from './tool-results.mjs';
import { registerProactiveTools } from './proactive/tools.mjs';
import { readToolFields, executeSharedReadTool } from './proactive/read-tool-registry.mjs';
import { createDiscordReadTools } from './proactive/read-tools.mjs';
import { addReaction } from './reactions.mjs';

const snowflake = z.string().regex(/^\d{17,20}$/).describe('Discord snowflake ID');
const messageFields = {
  content: z.string().max(2000).optional(),
  stickerIds: z.array(snowflake).max(3).default([]),
  gifUrl: z.string().url().max(2048).optional().describe('An existing HTTPS GIF or GIF page URL to embed in the message'),
};

export function createDiscordMcpServer(service, { novaOptions = {} } = {}) {
  const server = new McpServer(
    { name: 'discord-readonly', version: '2.9.0' },
    {
      instructions:
        'Discord bot access. Prefer discord_read for URLs. Use ordinary messages in DMs and for standalone mentions; use discord_reply for server follow-up chains when it clarifies the target. Use discord_list_servers and discord_list_channels to resolve names, discord_user_info for profiles, discord_list_expressions for custom emojis/stickers, discord_add_reaction for emoji reactions, and discord_forward_messages to natively forward existing messages and their attachments. Be playful and concise; use server emojis naturally and discord_send_messages for a few short conversational bubbles. Only send or react when requested or under an explicitly started proactive listener. Start proactive mode only when asked; stop it when asked.',
    },
  );

  register(server, 'discord_list_servers', {
    title: 'List Discord Servers',
    description: 'List every Discord server visible to the configured bot account(s), including account health.',
    inputSchema: readToolFields('discord_list_servers', { trustedLocal: true }),
  }, async ({ refresh }) => {
    const result = await executeSharedReadTool(service, 'discord_list_servers', { refresh });
    const allAccountsFailed = result.accounts.length > 0 && result.accounts.every((account) => account.error);

    return { ...success(result), ...(allAccountsFailed ? { isError: true } : {}) };
  });

  register(server, 'discord_list_channels', {
    title: 'List Discord Channels',
    description: 'List a server channel tree. Includes active threads by default and can page archived public/joined-private threads.',
    inputSchema: readToolFields('discord_list_channels', { trustedLocal: true }),
  }, async (args) => success(await executeSharedReadTool(service, 'discord_list_channels', args)));

  register(server, 'discord_list_tickets', {
    title: 'List Discord Tickets',
    description: 'List ticket-like forum posts and threads, optionally including text channels under configured categories. Supports archived tickets and an explicit updatedAfter filter for external periodic callers.',
    inputSchema: {
      guildId: snowflake,
      parentChannelIds: z.array(snowflake).default([]),
      categoryIds: z.array(snowflake).default([]),
      includeArchived: z.boolean().default(true),
      includeTextChannels: z.boolean().default(false),
      namePattern: z.string().max(200).optional(),
      updatedAfter: z.string().datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(500).default(200),
    },
  }, async (args) => success(await service.listTickets(args)));

  register(server, 'discord_read', {
    title: 'Read Discord',
    description: 'Read a Discord message URL, channel URL, message ID, channel, or ticket thread. Automatically selects an authorized bot. Image attachments are returned as MCP image content by default.',
    inputSchema: {
      url: z.string().url().optional().describe('Discord /channels/<guild>/<channel>[/<message>] URL'),
      guildId: snowflake.optional(),
      channelId: snowflake.optional(),
      messageId: snowflake.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      before: snowflake.optional(),
      after: snowflake.optional(),
      around: snowflake.optional(),
      includeImages: z.boolean().default(true),
      maxImages: z.number().int().min(1).max(10).optional(),
      includeArchivedThreads: z.boolean().default(false),
    },
  }, async (args) => {
    const result = await service.read(args);
    return success(result.structured, result.images);
  });

  register(server, 'discord_search_messages', {
    title: 'Search Discord Server Messages',
    description: 'Search Discord indexed messages across bot-accessible server channels. Returns up to 250 matches by paging Discord search results, with message links and continuation arguments. Default sort is newest first. Use discord_message_context to jump into a result conversation.',
    inputSchema: readToolFields('discord_search_messages', { trustedLocal: true }),
  }, async (args) => success(await executeSharedReadTool(service, 'discord_search_messages', args)));

  register(server, 'discord_message_context', {
    title: 'Jump to Discord Message Context',
    description: 'Open a specific message link or message ID and read its surrounding conversation in chronological order. Returns the anchor, up to 250 messages, and arguments for browsing older or newer context. Images are opt-in.',
    inputSchema: readToolFields('discord_message_context', { trustedLocal: true }),
  }, async (args) => {
    const { toolImages, ...result } = await executeSharedReadTool(service, 'discord_message_context', args);
    return success(result, toolImages);
  });

  register(server, 'discord_browse_messages', {
    title: 'Browse Discord Conversation History',
    description: 'Continue through channel history with before/after cursors, or open an around/message anchor. Reads up to 250 messages per call and returns chronological messages plus older/newer navigation arguments.',
    inputSchema: readToolFields('discord_browse_messages', { trustedLocal: true }),
  }, async (args) => {
    const { toolImages, ...result } = await executeSharedReadTool(service, 'discord_browse_messages', args);
    return success(result, toolImages);
  });

  register(server, 'discord_fetch_attachment', {
    title: 'Fetch Discord Image',
    description: 'Fetch one image from a Discord message using a fresh lookup, or from a direct Discord CDN/media URL. Only approved Discord media hosts and image MIME types are allowed.',
    inputSchema: {
      messageUrl: z.string().url().optional(),
      attachmentUrl: z.string().url().optional(),
      attachmentId: z.string().optional(),
      filename: z.string().optional(),
      index: z.number().int().min(0).max(20).default(0),
    },
  }, async (args) => {
    const result = await service.fetchAttachment(args);
    return success(result.structured, [result.image]);
  });

  register(server, 'discord_check_access', {
    title: 'Check Discord Access',
    description: 'Probe each configured bot account for read access to a guild, channel, and optional message. Useful for diagnosing ticket permissions.',
    inputSchema: { guildId: snowflake.optional(), channelId: snowflake.optional(), messageId: snowflake.optional() },
  }, async (args) => success(await service.checkAccess(args)));

  register(server, 'discord_list_expressions', {
    title: 'List Discord Emojis and Stickers',
    description: "List a server's custom emojis and stickers, including emoji markup, sticker IDs, availability, and emoji role restrictions. Put emoji markup in discord_send_message.content and sticker IDs in stickerIds.",
    inputSchema: {
      guildId: snowflake,
      kind: z.enum(['all', 'emojis', 'stickers']).default('all'),
    },
  }, async (args) => success(await listExpressions(service, args)));

  register(server, 'discord_send_message', {
    title: 'Send Discord Message',
    description: "Send a message as the configured bot to a channel or thread. Only use when explicitly asked to send. Supports custom emoji markup in content and up to 3 server sticker IDs. Mention notifications are disabled unless allowMentions is true. Reuse the returned nonce when retrying the same send to prevent duplicates within Discord's nonce window.",
    annotations: writeAnnotations,
    inputSchema: {
      guildId: snowflake.optional(),
      channelId: snowflake,
      ...messageFields,
      replyToMessageId: snowflake.optional(),
      mentionRepliedUser: z.boolean().default(false),
      allowMentions: z.boolean().default(false),
      nonce: z.string().min(1).max(25).optional(),
    },
  }, async (args) => success(await sendMessage(service, args)));

  register(server, 'discord_reply', {
    title: 'Reply to Discord Message',
    description: 'Use Discord native reply UI to answer a specific message, rather than manually mentioning its author. The reply author is not pinged unless mentionRepliedUser is true.',
    annotations: writeAnnotations,
    inputSchema: {
      guildId: snowflake.optional(), channelId: snowflake, messageId: snowflake,
      ...messageFields,
      mentionRepliedUser: z.boolean().default(false), allowMentions: z.boolean().default(false),
      nonce: z.string().min(1).max(25).optional(),
    },
  }, async ({ messageId, ...args }) => success(await sendMessage(service, { ...args, replyToMessageId: messageId })));

  register(server, 'discord_send_messages', {
    title: 'Send Discord Message Batch',
    description: 'Send 1 to 5 short messages in order with a brief interval, like conversational message bubbles. Only the first message uses an optional native reply reference. Stops on failure and reports messages already sent.',
    annotations: writeAnnotations,
    inputSchema: {
      guildId: snowflake.optional(), channelId: snowflake,
      messages: z.array(z.object(messageFields)).min(1).max(5),
      replyToMessageId: snowflake.optional(), mentionRepliedUser: z.boolean().default(false),
      allowMentions: z.boolean().default(false), intervalMs: z.number().int().min(0).max(5000).default(650),
      batchId: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/).optional(),
    },
  }, async (args) => success(await sendMessageBatch(service, args)));

  register(server, 'discord_forward_messages', {
    title: 'Forward Discord Messages',
    description: "Natively forward 1 to 10 existing messages, including their attachments, into a channel, thread or DM, in order. Sources can be message URLs or channelId plus messageId, from any channel the bot can read. Forwards cannot carry extra text; send a separate message for commentary. Only use when explicitly asked. Stops on failure and reports forwards already sent.",
    annotations: writeAnnotations,
    inputSchema: {
      guildId: snowflake.optional(), channelId: snowflake.describe('Destination channel or thread ID'),
      messages: z.array(z.object({
        url: z.string().url().optional().describe('Discord message URL to forward'),
        guildId: snowflake.optional(), channelId: snowflake.optional(), messageId: snowflake.optional(),
      })).min(1).max(10),
      intervalMs: z.number().int().min(0).max(5000).default(650),
      batchId: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/).optional(),
    },
  }, async (args) => success(await forwardMessages(service, args)));

  register(server, 'discord_user_info', {
    title: 'Get Discord User Info',
    description: 'Read a public user profile, avatar and account creation date. With guildId, also return server nickname, join date and roles. Does not report live presence.',
    inputSchema: readToolFields('discord_user_info', { trustedLocal: true }),
  }, async (args) => success(await executeSharedReadTool(service, 'discord_user_info', args)));

  register(server, 'discord_add_reaction', {
    title: 'React to Discord Message',
    description: 'Add the bot reaction to a message using one Unicode emoji or custom emoji markup/name:id. Discord enforces emoji availability and channel permissions. Use when the user requests a reaction or under an explicitly enabled automatic conversation.',
    annotations: { ...writeAnnotations, idempotentHint: true },
    inputSchema: { guildId: snowflake.optional(), channelId: snowflake, messageId: snowflake, emoji: z.string().min(1).max(100) },
  }, async (args) => success(await addReaction(service, args)));


  const readTools = createDiscordReadTools(service, { trustedLocal: true, directMessages: true }, novaOptions);
  const existingReads = new Set(['discord_list_servers', 'discord_list_channels', 'discord_search_messages', 'discord_message_context', 'discord_browse_messages', 'discord_user_info']);
  for (const tool of readTools.registry) {
    if (existingReads.has(tool.name)) continue;
    register(server, tool.name, {
      title: tool.name.replaceAll('_', ' '), description: tool.spec.description, inputSchema: tool.schema.shape,
    }, async (args) => {
      const result = await readTools.call(tool.name, args);
      const text = result.contentItems.find((item) => item.type === 'inputText')?.text || '{}';
      const images = result.contentItems.filter((item) => item.type === 'inputImage').map((item) => {
        const match = /^data:([^;]+);base64,(.*)$/.exec(item.imageUrl);
        return { type: 'image', mimeType: match[1], data: match[2] };
      });
      return success(JSON.parse(text), images);
    });
  }

  registerProactiveTools(server, service);

  register(server, 'discord_get_message', {
    title: 'Get Discord Message (Legacy)',
    description: 'Compatibility alias: fetch one Discord message by channel and message ID.',
    inputSchema: { channelId: snowflake, messageId: snowflake },
  }, async (args) => success(await service.legacyGetMessage(args)));

  register(server, 'discord_read_messages', {
    title: 'Read Discord Messages (Legacy)',
    description: 'Compatibility alias: list messages in a channel with Discord snowflake cursors.',
    inputSchema: {
      channelId: snowflake,
      limit: z.number().int().min(1).max(100).default(50),
      before: snowflake.optional(),
      after: snowflake.optional(),
      around: snowflake.optional(),
    },
  }, async (args) => success(await service.legacyReadMessages(args)));

  register(server, 'discord_get_channel', {
    title: 'Get Discord Channel (Legacy)',
    description: 'Compatibility alias: get raw metadata for one channel or thread.',
    inputSchema: { channelId: snowflake },
  }, async (args) => success(await service.legacyGetChannel(args)));

  register(server, 'discord_get_server_info', {
    title: 'Get Discord Server (Legacy)',
    description: 'Compatibility alias: get one guild and its base channels.',
    inputSchema: { guildId: snowflake },
  }, async (args) => success(await service.legacyGetServerInfo(args)));

  return server;
}

export async function runStdioServer(service, options) {
  const server = createDiscordMcpServer(service, options);
  await server.connect(new StdioServerTransport());
  return server;
}
