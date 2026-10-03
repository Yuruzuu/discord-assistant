import { z } from 'zod/v4';
import { register, success, writeAnnotations } from '../tool-results.mjs';
import { createProactiveController } from './controller.mjs';
import { directMessageOwnerId } from './target.mjs';

export function registerProactiveTools(server, service, controller = createProactiveController(service)) {
  const snowflake = z.string().regex(/^\d{17,20}$/);
  const target = { channelId: snowflake, accountId: z.string().optional() };
  const replyOptions = {
    model: z.string().max(128).optional(), reasoningEffort: z.enum(['low', 'medium', 'high']).default('low'),
    batchWindowMs: z.number().int().min(250).max(5000).default(1500),
    cooldownMs: z.number().int().min(0).max(60000).default(5000),
    maxRepliesPerMinute: z.number().int().min(1).max(60).default(6),
    gifUrls: z.array(z.string().url().max(2048)).max(10).default([]).describe('Optional existing HTTPS GIF links the bot may use'),
  };
  register(server, 'discord_start_proactive', {
    title: 'Start Proactive Discord Listener',
    description: 'Start an on-demand background Gateway listener for one channel. It uses logged-in Codex CLI to generate native replies and short message batches. Uses Codex quota while active. Only start when explicitly asked. Default mode responds to bot mentions and replies to the bot. Stop before changing an already active listener configuration.',
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
}
