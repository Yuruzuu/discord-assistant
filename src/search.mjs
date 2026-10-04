import { assertSnowflake } from './discord-url.mjs';
import { shapeMessage, shapeChannel } from './shapes.mjs';

const pageSize = 25;
const maximumOffset = 9975;

export async function searchMessages(service, {
  guildId, query = '', channelIds = [], authorIds = [], mentionsUserIds = [], repliedToMessageIds = [],
  has = [], embedTypes = [], beforeId, afterId, pinned, includeNsfw = false,
  sortBy = 'timestamp', sortOrder = 'desc', limit = 250, offset = 0, accountId,
}, { signal } = {}) {
  signal?.throwIfAborted();
  assertSnowflake(guildId, 'guildId');
  for (const [label, values] of Object.entries({ channelIds, authorIds, mentionsUserIds, repliedToMessageIds })) {
    for (const value of values) assertSnowflake(value, label);
  }
  if (beforeId) assertSnowflake(beforeId, 'beforeId');
  if (afterId) assertSnowflake(afterId, 'afterId');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error('Search limit must be between 1 and 250');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximumOffset) throw new Error('Search offset must be between 0 and 9975');
  if (typeof query !== 'string' || query.length > 1024) throw new Error('Search query must be at most 1024 characters');

  const account = accountId ? service.accountById(accountId) : await service.accountForGuild(guildId);
  const messages = new Map();
  const threads = new Map();
  let nextOffset = offset;
  let totalResults = null;
  let doingHistoricalIndex = false;
  let pagesFetched = 0;
  while (messages.size < limit && nextOffset <= maximumOffset && pagesFetched < 20) {
    signal?.throwIfAborted();
    const requested = Math.min(pageSize, limit - messages.size, maximumOffset + pageSize - nextOffset);
    const result = await account.client.searchGuildMessages(guildId, {
      content: query || undefined,
      channel_id: [...new Set(channelIds)].sort(), author_id: [...new Set(authorIds)].sort(),
      mentions: [...new Set(mentionsUserIds)].sort(), replied_to_message_id: [...new Set(repliedToMessageIds)].sort(),
      has: [...new Set(has)].sort(), embed_type: [...new Set(embedTypes)].sort(),
      max_id: beforeId, min_id: afterId, pinned, include_nsfw: includeNsfw,
      sort_by: sortBy, sort_order: sortOrder, limit: requested, offset: nextOffset,
    }, { signal });
    signal?.throwIfAborted();
    pagesFetched += 1;
    totalResults = Number.isFinite(result.total_results) ? result.total_results : totalResults;
    doingHistoricalIndex ||= Boolean(result.doing_deep_historical_index);
    for (const group of result.messages) {
      for (const message of group) {
        if (message.hit === false || messages.has(message.id)) continue;
        messages.set(message.id, shapeMessage({ ...message, guild_id: message.guild_id || guildId }));
      }
    }
    for (const thread of result.threads || []) threads.set(thread.id, shapeChannel({ ...thread, guild_id: thread.guild_id || guildId }));
    nextOffset += requested;
    if (totalResults !== null && nextOffset >= totalResults) break;
  }
  const hasMore = totalResults === null || nextOffset < totalResults;
  const offsetLimitReached = hasMore && nextOffset > maximumOffset;
  const canContinue = hasMore && !offsetLimitReached;

  return {
    accountId: account.id, guildId, query,
    messages: [...messages.values()].slice(0, limit), threads: [...threads.values()],
    totalResults, offset, nextOffset: canContinue ? nextOffset : null,
    hasMore, offsetLimitReached, pagesFetched, doingHistoricalIndex,
    continuation: canContinue ? {
      guildId, query, channelIds, authorIds, mentionsUserIds, repliedToMessageIds, has, embedTypes,
      beforeId, afterId, pinned, includeNsfw, sortBy, sortOrder, limit, offset: nextOffset, accountId: account.id,
    } : null,
    contextTool: 'discord_message_context',
  };
}
