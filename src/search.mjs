import { assertSnowflake, compareSnowflakes, snowflakeTimestamp } from './discord-url.mjs';
import { mapConcurrent } from './concurrency.mjs';
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
  const uniqueSorted = (values) => [...new Set(values)].sort();
  const filters = {
    content: query || undefined,
    channel_id: uniqueSorted(channelIds), author_id: uniqueSorted(authorIds),
    mentions: uniqueSorted(mentionsUserIds), replied_to_message_id: uniqueSorted(repliedToMessageIds),
    has: uniqueSorted(has), embed_type: uniqueSorted(embedTypes),
    max_id: beforeId, min_id: afterId, pinned, include_nsfw: includeNsfw,
    sort_by: sortBy, sort_order: sortOrder,
  };
  const messages = new Map();
  const threads = new Map();
  let nextOffset = offset;
  let totalResults = null;
  let doingHistoricalIndex = false;
  let pagesFetched = 0;
  const fetchPage = async (pageOffset, requested) => {
    signal?.throwIfAborted();
    const result = await account.client.searchGuildMessages(guildId, { ...filters, limit: requested, offset: pageOffset }, { signal });
    signal?.throwIfAborted();
    return result;
  };
  const absorb = (result, requested) => {
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
  };
  const firstRequested = Math.min(pageSize, limit, maximumOffset + pageSize - nextOffset);
  absorb(await fetchPage(nextOffset, firstRequested), firstRequested);
  // The first page reports the total, so the remaining pages are known up front and fetched a few at a time instead of one by one.
  while (messages.size < limit && nextOffset <= maximumOffset && pagesFetched < 20 && (totalResults === null || nextOffset < totalResults)) {
    const pages = [];
    let plannedOffset = nextOffset;
    let planned = messages.size;
    while (pages.length < 3 && planned < limit && plannedOffset <= maximumOffset && pagesFetched + pages.length < 20 && (totalResults === null || plannedOffset < totalResults)) {
      const requested = Math.min(pageSize, limit - planned, maximumOffset + pageSize - plannedOffset);
      pages.push({ offset: plannedOffset, requested });
      plannedOffset += requested;
      planned += requested;
      if (totalResults === null) break;
    }
    const results = await mapConcurrent(pages, 3, (page) => fetchPage(page.offset, page.requested));
    for (const [index, result] of results.entries()) absorb(result, pages[index].requested);
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

// Runs several keyword/filter variants in one call: small pages, bounded concurrency, one routed account, and hits merged across searches.
export async function searchMessagesBatch(service, {
  guildId, searches, channelIds = [], authorIds = [], beforeId, afterId, sortOrder = 'desc', limitPerSearch = 25, includeNsfw = false, accountId,
}, { signal } = {}) {
  signal?.throwIfAborted();
  assertSnowflake(guildId, 'guildId');
  if (!Array.isArray(searches) || searches.length < 1 || searches.length > 10) throw new Error('Provide 1 to 10 searches');
  if (!Number.isSafeInteger(limitPerSearch) || limitPerSearch < 1 || limitPerSearch > 100) throw new Error('limitPerSearch must be between 1 and 100');
  const account = accountId ? service.accountById(accountId) : await service.accountForGuild(guildId);
  const outcomes = await mapConcurrent(searches, 3, async (search) => {
    const filters = {
      guildId, query: search.query || '', channelIds: search.channelIds?.length ? search.channelIds : channelIds,
      authorIds: search.authorIds?.length ? search.authorIds : authorIds, has: search.has || [],
      beforeId, afterId, sortOrder, includeNsfw, limit: limitPerSearch, accountId: account.id,
    };
    try { return { filters, result: await searchMessages(service, filters, { signal }) }; }
    catch (error) { signal?.throwIfAborted(); return { filters, error: String(error.message).slice(0, 300) }; }
  });
  const merged = new Map();
  const summaries = outcomes.map(({ filters, result, error }, index) => {
    for (const message of result?.messages || []) {
      const existing = merged.get(message.id);
      if (existing) { existing.matchedSearches.push(index); continue; }
      merged.set(message.id, {
        id: message.id, channelId: message.channelId, url: message.url, author: message.author, authorId: message.authorId, timestamp: message.timestamp, unix: Math.floor(snowflakeTimestamp(message.id) / 1000),
        content: message.content.length > 600 ? `${message.content.slice(0, 600)}…` : message.content,
        ...(message.attachments.length ? { attachments: message.attachments.length } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}), matchedSearches: [index],
      });
    }
    return { index, query: filters.query, channelIds: filters.channelIds, authorIds: filters.authorIds, ...(error ? { error } : {
      totalResults: result.totalResults, returned: result.messages.length, hasMore: result.hasMore, doingHistoricalIndex: result.doingHistoricalIndex,
      continuation: result.continuation ? { ...result.continuation, limit: 250 } : null,
    }) };
  });
  const messages = [...merged.values()].sort((left, right) => compareSnowflakes(right.id, left.id) * (sortOrder === 'asc' ? -1 : 1));

  return { accountId: account.id, guildId, searches: summaries, uniqueMessages: messages.length, messages,
    nextStep: 'Open promising hits with discord_message_context. To dig deeper into one search, call discord_search_messages with its continuation.' };
}
