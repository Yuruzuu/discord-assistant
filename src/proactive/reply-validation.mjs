import { z } from 'zod/v4';

const messageSchema = z.object({
  content: z.string().max(2000), gifUrl: z.string().nullable(),
  stickerIds: z.array(z.string().regex(/^\d{17,20}$/)).max(3),
}).strict();
const planSchema = z.object({ shouldReply: z.boolean(), messages: z.array(messageSchema).max(5) }).strict();

export function createReplyValidator(context) {
  const allowedGifs = new Set(context.allowedGifUrls || []);
  const stickers = new Set((context.expressions?.stickers || []).filter((sticker) => sticker.available).map((sticker) => sticker.id));
  const emojis = new Set((context.expressions?.emojis || []).map((emoji) => emoji.markup));
  function validateParsedMessage(message) {
    if (message.gifUrl && !allowedGifs.has(message.gifUrl)) throw new Error('Codex selected a GIF outside the supplied catalog');
    if (message.stickerIds.some((id) => !stickers.has(id))) throw new Error('Codex selected an unavailable server sticker');
    for (const match of message.content.matchAll(/<a?:[A-Za-z0-9_]+:\d+>/g)) {
      if (!emojis.has(match[0])) throw new Error('Codex selected an unavailable custom emoji');
    }
    const combined = [message.content, message.gifUrl].filter(Boolean).join('\n');
    if (combined.length > 2000 || (!combined.trim() && !message.stickerIds.length)) throw new Error('Codex generated an invalid message');

    return { ...message, gifUrl: message.gifUrl || undefined };
  }

  function message(value) { return validateParsedMessage(messageSchema.parse(value)); }
  function plan(value) {
    const parsed = planSchema.parse(value);
    if (!parsed.shouldReply) return { shouldReply: false, messages: [] };
    if (!parsed.messages.length) throw new Error('Codex chose to reply without providing any messages');
    return { ...parsed, messages: parsed.messages.map(validateParsedMessage) };
  }

  return { message, plan };
}

export function validateReplyMessage(value, context) {
  return createReplyValidator(context).message(value);
}

export function validateReplyPlan(value, context) {
  return createReplyValidator(context).plan(value);
}
