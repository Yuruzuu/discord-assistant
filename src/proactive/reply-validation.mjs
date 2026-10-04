import { z } from 'zod/v4';
import { normalizeReactionEmoji } from '../reactions.mjs';
import { validateGeneratedFiles } from './discord-chunks.mjs';

const messageSchema = z.object({
  content: z.string().max(16000), gifUrl: z.string().nullable(),
  stickerIds: z.array(z.string().regex(/^\d{17,20}$/)).max(3),
}).strict();
const reactionSchema = z.object({ messageId: z.string().regex(/^\d{17,20}$/), emoji: z.string().min(1).max(100) }).strict();
const forwardSchema = z.object({ channelId: z.string().regex(/^\d{17,20}$/), messageId: z.string().regex(/^\d{17,20}$/) }).strict();
const planSchema = z.object({ shouldReply: z.boolean(), messages: z.array(messageSchema).max(5), reactions: z.array(reactionSchema).max(3).default([]), forwards: z.array(forwardSchema).max(5).default([]), files: z.array(z.object({ name: z.string(), content: z.string() }).strict()).max(3).default([]) }).strict();

export function createReplyValidator(context) {
  const allowedGifs = new Set(context.allowedGifUrls || []);
  const stickers = new Set((context.expressions?.stickers || []).filter((sticker) => sticker.available).map((sticker) => sticker.id));
  const emojis = new Set((context.expressions?.emojis || []).map((emoji) => emoji.markup));
  const reactionTargets = new Set([...(context.triggerMessages || []), ...(context.recentMessages || []), ...(context.replyMessages || [])]
    .filter((message) => (!message.channel_id && !message.channelId) || (message.channel_id || message.channelId) === context.channelId).map((message) => message.id));
  function validateParsedMessage(message) {
    if (message.gifUrl && !allowedGifs.has(message.gifUrl)) throw new Error('Codex selected a GIF outside the supplied catalog');
    if (message.stickerIds.some((id) => !stickers.has(id))) throw new Error('Codex selected an unavailable server sticker');
    for (const match of message.content.matchAll(/<a?:[A-Za-z0-9_]+:\d+>/g)) {
      if (!emojis.has(match[0])) throw new Error('Codex selected an unavailable custom emoji');
    }
    const combined = [message.content, message.gifUrl].filter(Boolean).join('\n');
    if (combined.length > 16000 || (!combined.trim() && !message.stickerIds.length)) throw new Error('Codex generated an invalid message');

    return { ...message, gifUrl: message.gifUrl || undefined };
  }

  function message(value) { return validateParsedMessage(messageSchema.parse(value)); }
  function plan(value) {
    const parsed = planSchema.parse(value);
    const files = validateGeneratedFiles(parsed.files);
    const reactions = [...new Map(parsed.reactions.map((reaction) => {
      if (!reactionTargets.has(reaction.messageId)) throw new Error('Codex selected a reaction outside the supplied conversation messages');
      const emoji = normalizeReactionEmoji(reaction.emoji);
      return [`${reaction.messageId}:${emoji}`, { ...reaction, emoji }];
    })).values()];
    if (!parsed.shouldReply) return { shouldReply: false, messages: [], ...(reactions.length ? { reactions } : {}) };
    const forwards = [...new Map(parsed.forwards.map((forward) => [forward.messageId, forward])).values()];
    if (!parsed.messages.length && !files.length && !forwards.length) throw new Error('Codex chose to reply without providing any messages');
    return { shouldReply: parsed.shouldReply, messages: parsed.messages.map(validateParsedMessage), ...(reactions.length ? { reactions } : {}), ...(files.length ? { files } : {}), ...(forwards.length ? { forwards } : {}) };
  }

  return { message, plan };
}

export function validateReplyMessage(value, context) {
  return createReplyValidator(context).message(value);
}

export function validateReplyPlan(value, context) {
  return createReplyValidator(context).plan(value);
}
