import { assertSnowflake } from './discord-url.mjs';

const segments = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function normalizeReactionEmoji(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Provide one Unicode emoji or a custom emoji');
  const markup = /^<a?:([A-Za-z0-9_]{2,32}):(\d{17,20})>$/.exec(value);
  if (markup) return `${markup[1]}:${markup[2]}`;
  if (/^[A-Za-z0-9_]{2,32}:\d{17,20}$/.test(value)) return value;
  if ([...segments.segment(value)].length !== 1 || !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(value)) throw new Error('Provide one Unicode emoji or a custom emoji');
  return value;
}

export async function addReaction(service, { guildId, channelId, messageId, emoji }, { signal } = {}) {
  assertSnowflake(messageId, 'messageId');
  const normalized = normalizeReactionEmoji(emoji);
  signal?.throwIfAborted();
  const { account, channel } = await service.resolveChannel(channelId, guildId);
  signal?.throwIfAborted();
  await account.client.addReaction(channel.id, messageId, normalized, { signal });
  return { accountId: account.id, channelId: channel.id, messageId, emoji: normalized, reacted: true };
}
