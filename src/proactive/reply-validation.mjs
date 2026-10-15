import { z } from 'zod/v4';
import { normalizeReactionEmoji } from '../reactions.mjs';
import { discordEmbeds, embedSchema, embedText, linkButtonRows, linkButtonSchema } from '../rich-messages.mjs';
import { validateGeneratedFiles } from './discord-chunks.mjs';

const messageSchema = z.object({
  content: z.string().max(16000), gifUrl: z.string().nullable(),
  stickerIds: z.array(z.string().regex(/^\d{17,20}$/)).max(3),
  embeds: z.array(embedSchema).max(3).default([]), buttons: z.array(linkButtonSchema).max(5).default([]),
}).strict();
const reactionSchema = z.object({ messageId: z.string().regex(/^\d{17,20}$/), emoji: z.string().min(1).max(100) }).strict();
const channelMessageSchema = z.object({ channelId: z.string().regex(/^\d{17,20}$/), content: z.string().max(2000), notify: z.boolean(), embeds: z.array(embedSchema).max(3).default([]), buttons: z.array(linkButtonSchema).max(5).default([]) }).strict();
// Embeds and link buttons are checked with the same converter the sender uses, then kept only when present so plain replies keep their shape.
function richParts({ embeds, buttons }) {
  const converted = discordEmbeds(embeds);
  linkButtonRows(buttons);
  return { converted, parts: { ...(embeds.length ? { embeds } : {}), ...(buttons.length ? { buttons } : {}) } };
}
const forwardSchema = z.object({ channelId: z.string().regex(/^\d{17,20}$/), messageId: z.string().regex(/^\d{17,20}$/) }).strict();
const planSchema = z.object({ shouldReply: z.boolean(), messages: z.array(messageSchema).max(5), reactions: z.array(reactionSchema).max(3).default([]), forwards: z.array(forwardSchema).max(5).default([]), controls: z.boolean().default(false), images: z.array(z.string().regex(/^img\d{1,2}$/)).max(4).default([]), channelMessages: z.array(channelMessageSchema).max(3).default([]), files: z.array(z.object({ name: z.string(), content: z.string() }).strict()).max(3).default([]) }).strict();

export function createReplyValidator(context) {
  const allowedGifs = new Set(context.allowedGifUrls || []);
  const stickers = new Set((context.expressions?.stickers || []).filter((sticker) => sticker.available).map((sticker) => sticker.id));
  const emojis = new Set((context.expressions?.emojis || []).map((emoji) => emoji.markup));
  const reactionTargets = new Set([...(context.triggerMessages || []), ...(context.recentMessages || []), ...(context.replyMessages || [])]
    .filter((message) => (!message.channel_id && !message.channelId) || (message.channel_id || message.channelId) === context.channelId).map((message) => message.id));
  function validateParsedMessage(message) {
    if (message.gifUrl && !allowedGifs.has(message.gifUrl)) throw new Error('Codex selected a GIF outside the supplied catalog');
    if (message.stickerIds.some((id) => !stickers.has(id))) throw new Error('Codex selected an unavailable server sticker');
    const { converted, parts } = richParts(message);
    for (const match of [message.content, ...converted.flatMap(embedText)].join('\n').matchAll(/<a?:[A-Za-z0-9_]+:\d+>/g)) {
      if (!emojis.has(match[0])) throw new Error('Codex selected an unavailable custom emoji');
    }
    const combined = [message.content, message.gifUrl].filter(Boolean).join('\n');
    if (combined.length > 16000 || (!combined.trim() && !message.stickerIds.length && !converted.length)) throw new Error('Codex generated an invalid message');

    const { embeds, buttons, ...plain } = message;
    return { ...plain, gifUrl: message.gifUrl || undefined, ...parts };
  }

  function message(value) { return validateParsedMessage(messageSchema.parse(value)); }
  function plan(value) {
    const parsed = planSchema.parse(value);
    const files = validateGeneratedFiles(parsed.files);
    const reactions = [...new Map(parsed.reactions.map((reaction) => {
      // Steered owner messages join triggerMessages after the turn starts, so they are checked at validation time.
      if (!reactionTargets.has(reaction.messageId) && !(context.triggerMessages || []).some((message) => message.id === reaction.messageId)) throw new Error('Codex selected a reaction outside the supplied conversation messages');
      const emoji = normalizeReactionEmoji(reaction.emoji);
      return [`${reaction.messageId}:${emoji}`, { ...reaction, emoji }];
    })).values()];
    if (!parsed.shouldReply) return { shouldReply: false, messages: [], ...(reactions.length ? { reactions } : {}) };
    const forwards = [...new Map(parsed.forwards.map((forward) => [forward.messageId, forward])).values()];
    const images = [...new Set(parsed.images)];
    const channelMessages = parsed.channelMessages.map((item) => {
      if (!context.directMessages) throw new Error('Codex tried to post in another channel outside the owner DM');
      const { converted, parts } = richParts(item);
      if (!item.content.trim() && !converted.length) throw new Error('Codex generated an empty channel message');
      return { channelId: item.channelId, content: item.content, notify: item.notify, ...parts };
    });
    if (!parsed.messages.length && !files.length && !forwards.length && !images.length && !channelMessages.length) throw new Error('Codex chose to reply without providing any messages');
    return { shouldReply: parsed.shouldReply, messages: parsed.messages.map(validateParsedMessage), ...(reactions.length ? { reactions } : {}), ...(files.length ? { files } : {}), ...(forwards.length ? { forwards } : {}), ...(parsed.controls ? { controls: true } : {}), ...(images.length ? { images } : {}), ...(channelMessages.length ? { channelMessages } : {}) };
  }

  return { message, plan };
}

export function validateReplyMessage(value, context) {
  return createReplyValidator(context).message(value);
}

export function validateReplyPlan(value, context) {
  return createReplyValidator(context).plan(value);
}
