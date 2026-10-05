import { assertSnowflake, compareSnowflakes, snowflakeTimestamp } from './discord-url.mjs';
import { mapConcurrent } from './concurrency.mjs';

const discordEpoch = 1420070400000n;
const messageChannelTypes = new Set([0, 2, 5, 10, 11, 12, 13]);
const threadTypes = new Set([10, 11, 12]);
const threadParentTypes = new Set([0, 5, 15, 16]);
const forumTypes = new Set([15, 16]);
const pageSize = 100;
const cacheTtlMs = 10 * 60 * 1000;
const cacheLimit = 60000;
const caches = new WeakMap();
const formatters = new Map();
const formats = {
  parts: ['en-US', { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }],
  day: ['en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }],
  time: ['en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }],
  dayTime: ['en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', month: 'short', day: 'numeric' }],
};

export function snowflakeAt(milliseconds) {
  return String((BigInt(Math.max(0, Math.floor(milliseconds))) - discordEpoch) << 22n);
}

function formatter(timeZone, kind) {
  const key = `${kind}:${timeZone}`;
  let format = formatters.get(key);
  if (!format) { const [locale, options] = formats[kind]; format = new Intl.DateTimeFormat(locale, { timeZone, ...options }); formatters.set(key, format); }
  return format;
}

function localParts(timeZone, kind, instant) {
  return Object.fromEntries(formatter(timeZone, kind).formatToParts(new Date(instant)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function zoneOffsetMs(timeZone, instant) {
  const parts = localParts(timeZone, 'parts', instant);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
}

// Local midnight in an IANA zone without a date library: guess, then correct by the zone offset at that instant (twice, for DST edges).
export function startOfDay(timeZone, instant, dayOffset = 0) {
  const { year, month, day } = localParts(timeZone, 'day', instant);
  const local = Date.UTC(year, month - 1, day + dayOffset);
  return local - zoneOffsetMs(timeZone, local - zoneOffsetMs(timeZone, local));
}

export function resolveTimeZone(value) {
  const zone = value || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try { formatter(zone, 'day'); return zone; }
  catch { throw new Error(`Unknown time zone: ${zone}`); }
}

export function activityWindow({ day, hours = 24, since, until, timeZone }, now = Date.now()) {
  let start;
  let end = until ? Date.parse(until) : now;
  if (since) start = Date.parse(since);
  else if (day === 'today') start = startOfDay(timeZone, now);
  else if (day === 'yesterday') { start = startOfDay(timeZone, now, -1); end = until ? end : startOfDay(timeZone, now); }
  else start = now - hours * 3600000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('since and until must be ISO timestamps');
  end = Math.min(end, now);
  if (end <= start) throw new Error('The activity window must end after it starts');
  if (end - start > 7 * 24 * 3600000) throw new Error('The activity window can cover at most 7 days; use discord_search_messages for older history');
  return { start, end };
}

function cacheFor(client) {
  let cache = caches.get(client);
  if (!cache) { cache = { channels: new Map(), archives: new Map(), size: 0 }; caches.set(client, cache); }
  return cache;
}

// Threads auto-archive after as little as an hour, so a busy morning thread is often archived by evening; like DiscordChatExporter's
// "include archived threads", recently archived public threads are discovered per parent, newest-archived first, with an early stop.
async function archivedThreads(client, parents, windowStart, { signal, deadline, now, concurrency }) {
  const cache = cacheFor(client);
  let errors = 0;
  const found = await mapConcurrent(parents, concurrency, async (parent) => {
    if (deadline.aborted) return [];
    const cached = cache.archives.get(parent.id);
    if (cached && now() - cached.fetchedAt < cacheTtlMs && cached.since <= windowStart) return cached.threads.filter((thread) => !(Date.parse(thread.thread_metadata?.archive_timestamp) < windowStart));
    try {
      signal?.throwIfAborted();
      const { threads } = await client.listArchivedThreads(parent.id, { kind: 'public', limit: 100, maxItems: 300, archivedAfter: windowStart });
      cache.archives.set(parent.id, { threads, since: windowStart, fetchedAt: now() });
      return threads;
    } catch (error) { signal?.throwIfAborted(); errors += 1; return []; }
  });
  return { threads: found.flat(), errors };
}

function displayName(user) {
  return user?.global_name || user?.username || 'unknown';
}

function compact(message) {
  const key = BigInt(message.id);
  const names = new Map((message.mentions || []).map((user) => [user.id, displayName(user)]));
  let text = String(message.content || '')
    .replace(/<@!?(\d{17,20})>/g, (match, id) => (names.has(id) ? `@${names.get(id)}` : match))
    .replace(/<a?:([A-Za-z0-9_]+):\d{17,20}>/g, ':$1:')
    .replace(/\s+/g, ' ').trim();
  const forwarded = (message.message_snapshots || []).map((snapshot) => String(snapshot?.message?.content || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (forwarded.length) text = `${text ? `${text} ` : ''}[forwarded: ${forwarded.join(' | ')}]`;
  if (!text && message.embeds?.length) text = message.embeds.map((embed) => [embed.title, embed.description].filter(Boolean).join(' — ')).filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim();
  const attachments = (message.attachments || []).map((attachment) => attachment.filename || 'file');
  if (message.sticker_items?.length) attachments.push(...message.sticker_items.map((sticker) => `sticker:${sticker.name}`));
  return {
    id: message.id, key, authorId: message.author?.id || null, author: displayName(message.author), bot: Boolean(message.author?.bot || message.webhook_id),
    at: Date.parse(message.timestamp) || snowflakeTimestamp(message.id), text, attachments,
    ...(message.referenced_message?.author ? { replyTo: displayName(message.referenced_message.author) } : {}),
  };
}

async function channelMessages(client, channel, startId, endMs, { maxMessages, budget, signal, now }) {
  const cache = cacheFor(client);
  const cached = cache.channels.get(channel.id);
  const entry = cached && now() - cached.fetchedAt < cacheTtlMs && compareSnowflakes(cached.coveredFrom, startId) <= 0
    ? cached : { coveredFrom: startId, newestId: startId, messages: new Map(), fetchedAt: now(), counted: 0 };
  let complete = true;
  for (;;) {
    signal?.throwIfAborted();
    if (budget.exhausted()) { complete = false; break; }
    const page = await client.listMessages(channel.id, { limit: pageSize, after: entry.newestId });
    if (!Array.isArray(page) || !page.length) break;
    let newest = entry.newestId;
    let newestKey = BigInt(newest);
    for (const message of page) {
      let compacted = entry.messages.get(message.id);
      if (!compacted) { compacted = compact(message); entry.messages.set(message.id, compacted); budget.take(1); }
      if (compacted.key > newestKey) { newestKey = compacted.key; newest = message.id; }
    }
    entry.newestId = newest;
    if (page.length < pageSize || snowflakeTimestamp(newest) > endMs) break;
    if (entry.messages.size >= maxMessages) { complete = false; break; }
  }
  entry.fetchedAt = now();
  // Messages are counted when an entry is stored, so a read that fails midway never skews the eviction total.
  cache.size += entry.messages.size - (cache.channels.get(channel.id)?.counted ?? 0);
  entry.counted = entry.messages.size;
  cache.channels.delete(channel.id);
  cache.channels.set(channel.id, entry);
  while (cache.size > cacheLimit && cache.channels.size > 1) {
    const [oldestId, oldest] = cache.channels.entries().next().value;
    cache.channels.delete(oldestId);
    cache.size -= oldest.counted;
  }
  const startKey = BigInt(startId);
  const messages = [...entry.messages.values()].filter((message) => message.key > startKey && message.at <= endMs);
  return { messages: messages.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)), complete };
}

// Zone offsets are whole minutes for any Discord-era instant, so one Intl call per minute labels every line in it on every render pass.
function timeLabels(timeZone, includeDate) {
  const format = formatter(timeZone, includeDate ? 'dayTime' : 'time');
  const labels = new Map();
  return (at) => {
    const minute = Math.floor(at / 60000);
    let label = labels.get(minute);
    if (label === undefined) { label = format.format(new Date(at)); labels.set(minute, label); }
    return label;
  };
}

function render(messages, { label, maxLength }) {
  const lines = [];
  let previous;
  for (const message of messages) {
    let text = message.text.length > maxLength ? `${message.text.slice(0, maxLength)}…` : message.text;
    if (message.attachments.length) text += `${text ? ' ' : ''}[${message.attachments.length === 1 ? message.attachments[0] : `${message.attachments.length} files`}]`;
    if (!text) continue;
    // Consecutive messages from one author within two minutes read as one turn, which saves most of the per-line overhead.
    if (previous && previous.authorId === message.authorId && message.at - previous.at < 120000 && !message.replyTo && lines.at(-1).length + text.length < maxLength * 3) {
      lines[lines.length - 1] += ` / ${text}`;
    } else {
      lines.push(`[${label(message.at)}|${Math.floor(message.at / 1000)}] ${message.author}${message.replyTo ? ` (reply to ${message.replyTo})` : ''}: ${text}`);
    }
    previous = message;
  }
  return lines;
}

export async function readServerActivity(service, {
  guildId, day, hours = 24, since, until, timeZone: requestedZone, channelIds = [], keywords = [], includeThreads = true, includeArchivedThreads = true, includeBots = false,
  maxMessages = 4000, maxCharacters = 120000, accountId,
}, { signal, now = Date.now, deadlineMs = 20000, concurrency = 10 } = {}) {
  signal?.throwIfAborted();
  assertSnowflake(guildId, 'guildId');
  for (const channelId of channelIds) assertSnowflake(channelId, 'channelId');
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 20000) throw new Error('maxMessages must be between 1 and 20000');
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 2000 || maxCharacters > 400000) throw new Error('maxCharacters must be between 2000 and 400000');
  if (!since && !day && (!Number.isFinite(hours) || hours <= 0 || hours > 168)) throw new Error('hours must be between 1 and 168');
  if (!Array.isArray(keywords) || keywords.length > 20 || keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100)) throw new Error('Provide at most 20 nonempty keywords');
  const startedAt = now();
  // The deadline covers the whole call, including channel listing, so callers with their own tool timeout always get an answer back.
  const deadline = AbortSignal.timeout(deadlineMs);
  const timeZone = resolveTimeZone(requestedZone);
  const window = activityWindow({ day, hours, since, until, timeZone }, startedAt);
  const startId = snowflakeAt(window.start);
  const account = accountId ? service.accountById(accountId) : (await service.resolveGuild(guildId)).account;
  const [channels, active] = await Promise.all([
    account.client.listGuildChannels(guildId),
    includeThreads ? account.client.listActiveGuildThreads(guildId) : Promise.resolve({ threads: [] }),
  ]);
  const byId = new Map([...(channels || []), ...(active?.threads || [])].map((channel) => [channel.id, channel]));
  const focus = new Set(channelIds);
  let fetched = 0;
  const budget = { take: (count) => { fetched += count; }, exhausted: () => fetched >= maxMessages || deadline.aborted };
  const perChannel = Math.max(1000, Math.ceil(maxMessages / 2));
  // A channel's last message ID encodes when it was last active, so idle channels are skipped without any request.
  const isCandidate = (channel) => messageChannelTypes.has(channel.type) && (includeThreads || !threadTypes.has(channel.type))
    && (!focus.size || focus.has(channel.id) || focus.has(channel.parent_id))
    && channel.last_message_id && compareSnowflakes(channel.last_message_id, startId) > 0;
  const byRecency = (left, right) => compareSnowflakes(right.last_message_id, left.last_message_id);
  const read = async (channel) => {
    if (budget.exhausted()) return { channel, messages: [], complete: false, notFetched: true };
    try { return { channel, ...await channelMessages(account.client, channel, startId, window.end, { maxMessages: perChannel, budget, signal, now }) }; }
    catch (error) {
      signal?.throwIfAborted();
      return { channel, messages: [], complete: false, error: error.status === 403 || error.code === 50001 ? 'no access' : String(error.message).slice(0, 200) };
    }
  };
  const known = [...byId.values()].filter(isCandidate).sort(byRecency);
  let archivedThreadErrors = 0;
  // Archive discovery runs gently beside the reads of channels already known to be active, so its latency overlaps instead of adding up.
  const discovery = includeThreads && includeArchivedThreads ? (async () => {
    const recentlyActive = snowflakeAt(startedAt - 14 * 24 * 3600000);
    const parents = [...byId.values()].filter((channel) => threadParentTypes.has(channel.type) && (!focus.size || focus.has(channel.id))
      && (forumTypes.has(channel.type) || (channel.last_message_id && compareSnowflakes(channel.last_message_id, recentlyActive) > 0)));
    const archived = await archivedThreads(account.client, parents, window.start, { signal, deadline, now, concurrency: 3 });
    archivedThreadErrors = archived.errors;
    const discovered = archived.threads.filter((thread) => !byId.has(thread.id));
    for (const thread of discovered) byId.set(thread.id, thread);
    return discovered.filter(isCandidate).sort(byRecency);
  })() : Promise.resolve([]);
  const [knownResults, discovered] = await Promise.all([mapConcurrent(known, concurrency, read), discovery]);
  const results = [...knownResults, ...await mapConcurrent(discovered, concurrency, read)];
  const skipped = channelIds.filter((id) => !byId.has(id)).map((channelId) => ({ channelId, reason: 'not a readable channel in this server' }));

  const terms = keywords.map((keyword) => keyword.trim().toLowerCase());
  let botMessagesSkipped = 0;
  const sections = [];
  for (const { channel, messages, complete, error, notFetched } of results) {
    if (error) { skipped.push({ channelId: channel.id, name: channel.name || null, reason: error }); continue; }
    if (notFetched) { skipped.push({ channelId: channel.id, name: channel.name || null, reason: 'not read before the time or message limit; request it with channelIds' }); continue; }
    let selected = messages;
    if (!includeBots) { const humans = selected.filter((message) => !message.bot); botMessagesSkipped += selected.length - humans.length; selected = humans; }
    if (terms.length) selected = selected.filter((message) => { const text = message.text.toLowerCase(); return terms.some((term) => text.includes(term)); });
    if (!selected.length) continue;
    const counts = new Map();
    for (const message of selected) {
      const current = counts.get(message.authorId) || { id: message.authorId, name: message.author, messages: 0 };
      current.messages += 1;
      counts.set(message.authorId, current);
    }
    const parent = threadTypes.has(channel.type) ? byId.get(channel.parent_id) : null;
    sections.push({ channel, parent, selected, complete, participants: [...counts.values()].sort((left, right) => right.messages - left.messages) });
  }
  sections.sort((left, right) => right.selected.length - left.selected.length);

  const label = timeLabels(timeZone, window.end - window.start > 24 * 3600000);
  let maxLength;
  let rendered;
  let sizes;
  let totalCharacters;
  // Shrink long messages first; only if that is not enough, keep each channel's most recent lines within a share of the budget.
  for (const length of [400, 220, 140]) {
    maxLength = length;
    rendered = sections.map((section) => render(section.selected, { label, maxLength }));
    sizes = rendered.map((lines) => lines.reduce((total, line) => total + line.length + 1, 0));
    totalCharacters = sizes.reduce((sum, size) => sum + size, 0);
    if (totalCharacters <= maxCharacters) break;
  }
  const channelsOut = sections.map((section, index) => {
    let lines = rendered[index];
    let omittedEarlier = 0;
    if (totalCharacters > maxCharacters) {
      const share = Math.max(1500, Math.floor(maxCharacters * sizes[index] / totalCharacters));
      let used = 0;
      let keep = 0;
      for (let cursor = lines.length - 1; cursor >= 0 && used + lines[cursor].length + 1 <= share; cursor -= 1) { used += lines[cursor].length + 1; keep += 1; }
      omittedEarlier = lines.length - keep;
      lines = lines.slice(lines.length - keep);
    }
    const { channel, parent, selected, complete, participants } = section;
    return {
      channelId: channel.id, name: channel.name || null, ...(parent ? { thread: true, parentId: parent.id, parentName: parent.name || null } : {}),
      messageCount: selected.length, firstAt: new Date(selected[0].at).toISOString(), lastAt: new Date(selected.at(-1).at).toISOString(), firstAtUnix: Math.floor(selected[0].at / 1000), lastAtUnix: Math.floor(selected.at(-1).at / 1000),
      participants: participants.slice(0, 8), ...(participants.length > 8 ? { otherParticipants: participants.length - 8 } : {}),
      ...(complete ? {} : { incomplete: true }), ...(omittedEarlier ? { omittedEarlierLines: omittedEarlier } : {}),
      transcript: lines.join('\n'),
    };
  });

  const messageCount = sections.reduce((sum, section) => sum + section.selected.length, 0);
  const partial = channelsOut.some((channel) => channel.incomplete || channel.omittedEarlierLines) || skipped.some((entry) => entry.reason.startsWith('not read'));
  return {
    accountId: account.id, guildId,
    window: { since: new Date(window.start).toISOString(), until: new Date(window.end).toISOString(), sinceUnix: Math.floor(window.start / 1000), untilUnix: Math.floor(window.end / 1000), timeZone },
    lineFormat: '[local time|Unix seconds] author (reply to X): message; " / " joins consecutive messages from one author',
    ...(terms.length ? { keywords } : {}),
    messageCount, activeChannels: channelsOut.length, channelsChecked: known.length + discovered.length, channelsInServer: byId.size,
    ...(botMessagesSkipped ? { botMessagesSkipped } : {}), ...(archivedThreadErrors ? { archivedThreadErrors } : {}), ...(maxLength < 400 ? { messagesShortenedTo: maxLength } : {}),
    channels: channelsOut, skipped, partial, elapsedMs: now() - startedAt, untrustedContent: true,
    nextStep: partial
      ? 'Some channels were shortened or not fully read. Call again with channelIds for the channels you need in full; recent reads are cached, so this is fast.'
      : 'This is every message in the window from the listed channels. Cite channels as <#channelId> and people as <@id> from participants.',
  };
}

export function clearActivityCache(client) {
  caches.delete(client);
}
