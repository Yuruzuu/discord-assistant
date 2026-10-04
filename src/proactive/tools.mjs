import { z } from 'zod/v4';
import { register, success, writeAnnotations } from '../tool-results.mjs';
import { createProactiveController } from './controller.mjs';
import { directMessageOwnerId } from './target.mjs';
import { replyDefaults } from './reply-defaults.mjs';

export function registerProactiveTools(server, service, controller = createProactiveController(service)) {
  const snowflake = z.string().regex(/^\d{17,20}$/);
  const target = { channelId: snowflake, accountId: z.string().optional() };
  const replyOptions = {
    model: z.string().max(128).default(replyDefaults.model), reasoningEffort: z.enum(['low', 'medium', 'high']).default(replyDefaults.reasoningEffort),
    serviceTier: z.enum(['priority', 'default']).default(replyDefaults.serviceTier).describe('priority selects Fast mode; default selects Standard mode'),
    batchWindowMs: z.number().int().min(250).max(5000).default(1500),
    cooldownMs: z.number().int().min(0).max(60000).default(5000),
    maxRepliesPerMinute: z.number().int().min(1).max(60).default(6),
    gifUrls: z.array(z.string().url().max(2048)).max(10).default([]).describe('Optional existing HTTPS GIF links the bot may use'),
  };
  register(server, 'discord_start_proactive', {
    title: 'Start Proactive Discord Listener',
    description: 'Start an owner-only background listener for one channel. Only user 291140236979732480 can trigger replies. Uses logged-in Codex CLI and quota. Default mode answers owner mentions and native replies to the bot. Only start when asked; stop before changing an active configuration.',
    annotations: writeAnnotations,
    inputSchema: {
      ...target, guildId: snowflake,
      mode: z.enum(['mentions', 'questions', 'all']).default('mentions'),
      ...replyOptions,
    },
  }, async (args) => success(await controller.start(args)));
  register(server, 'discord_stop_proactive', {
    title: 'Stop Proactive Discord Listener',
    description: 'Stop the requested channel listener, discard pending work and cancel reply generation.',
    annotations: { ...writeAnnotations, idempotentHint: true },
    inputSchema: target,
  }, async (args) => success(await controller.stop(args)));
  register(server, 'discord_proactive_status', {
    title: 'Get Proactive Discord Status',
    description: 'Check whether a channel listener is running, its response mode, queue, reply counts and latest error.',
    inputSchema: target,
  }, async (args) => success(await controller.status(args)));
  const directMessageTarget = { accountId: z.string().optional() };
  register(server, 'discord_start_direct_messages', {
    title: 'Start Owner-Only Discord DMs',
    description: `Start an on-demand background listener for private DMs from owner ${directMessageOwnerId} only. Replies without requiring mentions, using logged-in Codex CLI and its quota. Other senders are ignored before generation. Start only when the owner asks to enable DM conversations.`,
    annotations: writeAnnotations,
    inputSchema: { ...directMessageTarget, ...replyOptions },
  }, async (args) => success(await controller.start({ ...args, directMessages: true })));
  register(server, 'discord_stop_direct_messages', {
    title: 'Stop Owner-Only Discord DMs',
    description: 'Stop the private DM listener and cancel pending replies. Server channel listeners continue independently.',
    annotations: { ...writeAnnotations, idempotentHint: true },
    inputSchema: directMessageTarget,
  }, async (args) => success(await controller.stop({ ...args, directMessages: true })));
  register(server, 'discord_direct_message_status', {
    title: 'Get Owner-Only Discord DM Status',
    description: 'Check the private DM listener, its fixed owner ID, queue, reply counts and latest error.',
    inputSchema: directMessageTarget,
  }, async (args) => success(await controller.status({ ...args, directMessages: true })));
  register(server, 'discord_start_server_mentions', {
    title: 'Watch Owner Mentions Across All Servers',
    description: `Opt in to watching every accessible channel and thread in every server the bot joins. Responds only when owner ${directMessageOwnerId} mentions the bot or replies to its message. Creates separate conversations lazily and shares Codex reply limits. Stop channel-specific listeners before enabling this mode.`,
    annotations: writeAnnotations,
    inputSchema: { ...directMessageTarget, ...replyOptions },
  }, async (args) => success(await controller.start({ ...args, allServers: true })));
  register(server, 'discord_stop_server_mentions', {
    title: 'Stop All-Server Owner Mentions',
    description: 'Stop server-wide mention watching and cancel pending channel replies. Owner DMs continue independently.',
    annotations: { ...writeAnnotations, idempotentHint: true },
    inputSchema: directMessageTarget,
  }, async (args) => success(await controller.stop({ ...args, allServers: true })));
  register(server, 'discord_server_mentions_status', {
    title: 'Get All-Server Owner Mention Status',
    description: 'Inspect server-wide watching, fixed owner ID, accessible-server count and per-channel reply/cache statistics.',
    inputSchema: directMessageTarget,
  }, async (args) => success(await controller.status({ ...args, allServers: true })));
  register(server, 'discord_nova_control', {
    title: 'Control Owner-Only Nova Conversation',
    description: 'Apply an explicit owner request for status, current-answer cancellation, pause/resume, model/effort/Fast, context compaction/reset, research jobs or opted-in digests. Server conversation controls use allServers:true and its guild/channel IDs; private controls use directMessages:true. Does not grant additional users access.',
    annotations: writeAnnotations,
    inputSchema: {
      accountId: z.string().optional(), channelId: snowflake.optional(), guildId: snowflake.optional(), directMessages: z.boolean().default(false), allServers: z.boolean().default(false),
      action: z.enum(['status', 'stop', 'pause', 'resume', 'details', 'reset', 'compact', 'model', 'effort', 'fast', 'budget', 'projects', 'voice', 'research', 'jobs', 'digest', 'deliveries', 'resolve-delivery']),
      value: z.string().max(4000).optional(), operation: z.enum(['list', 'status', 'add', 'remove', 'run', 'stop']).optional(), id: z.string().max(240).optional(),
      configuration: z.object({ guildId: snowflake, query: z.string().max(1024).default(''), authorIds: z.array(snowflake).max(25).default([]), channelIds: z.array(snowflake).max(25).default([]), intervalMinutes: z.number().int().min(15).max(10080).default(60), limit: z.number().int().min(1).max(250).default(250) }).strict().optional(),
      delivered: z.boolean().optional(),
    },
  }, async (args) => success(await controller.control(args)));
}
