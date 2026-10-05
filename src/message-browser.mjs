import { shapeChannel, shapeMessage } from './shapes.mjs';
import { compareSnowflakes, validateCursors } from './discord-url.mjs';

function compareMessages(left, right) {
  return compareSnowflakes(left.id, right.id);
}

async function readRange(client, channelId, direction, cursor, limit, signal) {
  const messages = new Map();
  let next = cursor;
  while (messages.size < limit) {
    signal?.throwIfAborted();
    const requested = Math.min(limit - messages.size, 100);
    const page = await client.listMessages(channelId, { [direction]: next, limit: requested });
    signal?.throwIfAborted();
    if (!Array.isArray(page)) throw new Error('Discord returned an invalid message history page');
    const ordered = [...page].sort(compareMessages);
    for (const message of ordered) messages.set(message.id, message);
    const candidate = direction === 'before' ? ordered[0]?.id : ordered.at(-1)?.id;
    const progressed = candidate && (!next || (direction === 'before' ? BigInt(candidate) < BigInt(next) : BigInt(candidate) > BigInt(next)));
    if (!progressed || page.length < requested) break;
    next = candidate;
  }

  return [...messages.values()].sort(compareMessages);
}

export async function browseMessages(service, {
  url, guildId, channelId, messageId, before, after, around, limit = 250, includeImages = false,
}, { signal } = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error('Browse limit must be between 1 and 250');
  validateCursors({ before, after, around });
  const source = service.normalizeReadSource({ url, guildId, channelId, messageId });
  if (source.messageId && (before || after || around)) throw new Error('Use a message anchor or a cursor, not both');
  const anchorId = source.messageId || around;
  const { account, channel } = await service.resolveChannel(source.channelId, source.guildId);
  signal?.throwIfAborted();
  let messages;
  let anchor;
  if (anchorId) {
    const [target, window] = await Promise.all([
      account.client.getMessage(source.channelId, anchorId),
      account.client.listMessages(source.channelId, { around: anchorId, limit: Math.min(limit, 100) }),
    ]);
    signal?.throwIfAborted();
    if (!Array.isArray(window)) throw new Error('Discord returned an invalid message history page');
    anchor = target;
    messages = [...new Map([target, ...window].map((message) => [message.id, message])).values()].sort(compareMessages);
    if (messages.length < limit) {
      const remaining = limit - messages.length;
      const [older, newer] = await Promise.all([
        readRange(account.client, source.channelId, 'before', messages[0].id, Math.floor(remaining / 2), signal),
        readRange(account.client, source.channelId, 'after', messages.at(-1).id, Math.ceil(remaining / 2), signal),
      ]);
      messages = [...older, ...messages, ...newer];
      const missing = limit - messages.length;
      if (missing > 0 && (older.length || newer.length)) {
        const direction = older.length < Math.floor(remaining / 2) ? 'after' : 'before';
        const cursor = direction === 'before' ? messages[0].id : messages.at(-1).id;
        const extra = await readRange(account.client, source.channelId, direction, cursor, missing, signal);
        messages = direction === 'before' ? [...extra, ...messages] : [...messages, ...extra];
      }
    }
  } else if (before || after) {
    messages = await readRange(account.client, source.channelId, before ? 'before' : 'after', before || after, limit, signal);
  } else {
    const latest = await account.client.listMessages(source.channelId, { limit: Math.min(limit, 100) });
    signal?.throwIfAborted();
    if (!Array.isArray(latest)) throw new Error('Discord returned an invalid message history page');
    messages = [...latest].sort(compareMessages);
    if (messages.length === 100 && limit > 100) messages = [
      ...await readRange(account.client, source.channelId, 'before', messages[0].id, limit - messages.length, signal), ...messages,
    ];
  }
  if (messages.length > limit) {
    const ordered = [...messages].sort(compareMessages);
    const position = anchorId ? ordered.findIndex((message) => message.id === anchorId) : ordered.length - 1;
    const start = Math.max(0, Math.min(position - Math.floor(limit / 2), ordered.length - limit));
    messages = ordered.slice(start, start + limit);
  }
  const resolvedGuildId = channel.guild_id || source.guildId;
  const enriched = [...new Map(messages.map((message) => [message.id, message])).values()].sort(compareMessages).map((message) => ({
    ...message, channel_id: message.channel_id || source.channelId, guild_id: message.guild_id || resolvedGuildId,
  }));
  const oldest = enriched[0]?.id || null;
  const newest = enriched.at(-1)?.id || null;
  const images = includeImages ? await service.imageContent(account, enriched) : { content: [], warnings: [] };
  const navigationTarget = { ...(resolvedGuildId ? { guildId: resolvedGuildId } : {}), channelId: source.channelId, limit };

  return {
    structured: {
      accountId: account.id, guildId: resolvedGuildId, channel: shapeChannel(channel),
      anchor: anchor ? shapeMessage({ ...anchor, channel_id: source.channelId, guild_id: resolvedGuildId }) : null,
      messages: enriched.map(shapeMessage), cursors: { oldest, newest }, imageWarnings: images.warnings,
      navigation: {
        older: oldest ? { ...navigationTarget, before: oldest } : null,
        newer: newest ? { ...navigationTarget, after: newest } : null,
      },
    },
    images: images.content,
  };
}
