import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { readServerActivity, snowflakeAt, startOfDay, activityWindow, clearActivityCache } from '../src/activity.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { searchMessages } from '../src/search.mjs';

const guildId = '100000000000000001';
const otherGuildId = '100000000000000002';
const now = Date.parse('2026-10-05T03:00:00+08:00');
const todayStart = Date.parse('2026-10-05T00:00:00+08:00');
const id = (ms, offset = 0) => (BigInt(snowflakeAt(ms)) + BigInt(offset)).toString();
const user = (name, extra = {}) => ({ id: { valk: '400000000000000001', lewi: '400000000000000002', ci: '400000000000000003' }[name], username: name, ...extra });

function server({ slowMs = 0 } = {}) {
  const general = '200000000000000001';
  const idle = '200000000000000002';
  const voice = '200000000000000003';
  const forum = '200000000000000004';
  const locked = '200000000000000005';
  const activeThread = '200000000000000010';
  const archivedToday = '200000000000000011';
  const archivedLongAgo = '200000000000000012';
  const messages = new Map();
  const add = (channelId, ms, author, content, extra = {}) => {
    const list = messages.get(channelId) || [];
    list.push({ id: id(ms, list.length), channel_id: channelId, author, content, timestamp: new Date(ms).toISOString(), attachments: [], embeds: [], mentions: [], ...extra });
    messages.set(channelId, list);
  };
  add(general, todayStart - 3600000, user('valk'), 'yesterday evening, outside the window');
  for (let index = 0; index < 150; index += 1) add(general, todayStart + 60000 + index * 30000, user(index % 2 ? 'lewi' : 'valk'), `general message ${index} about fate`);
  add(general, todayStart + 2 * 3600000, user('ci', { bot: true }), 'build passed');
  add(voice, todayStart + 1800000, user('lewi'), 'voice chat note <:pog:300000000000000099> for <@400000000000000001>', { mentions: [user('valk', { global_name: 'Valk' })] });
  add(activeThread, todayStart + 2400000, user('valk'), 'thread reply about the bow');
  add(activeThread, todayStart + 2430000, user('valk'), 'and one more thought');
  add(archivedToday, todayStart + 600000, user('lewi'), 'archived morning thread about fate');
  add(locked, todayStart + 600000, user('lewi'), 'secret');
  const channels = [
    { id: general, guild_id: guildId, type: 0, name: 'general', last_message_id: messages.get(general).at(-1).id },
    { id: idle, guild_id: guildId, type: 0, name: 'idle', last_message_id: id(todayStart - 40 * 24 * 3600000) },
    { id: voice, guild_id: guildId, type: 2, name: 'voice', last_message_id: messages.get(voice).at(-1).id },
    { id: forum, guild_id: guildId, type: 15, name: 'bugs', last_message_id: id(todayStart - 90 * 24 * 3600000) },
    { id: locked, guild_id: guildId, type: 0, name: 'locked', last_message_id: messages.get(locked).at(-1).id },
    { id: '200000000000000006', guild_id: guildId, type: 4, name: 'category' },
  ];
  const calls = [];
  const client = {
    listGuildChannels: async () => channels,
    listActiveGuildThreads: async () => ({ threads: [{ id: activeThread, guild_id: guildId, type: 11, name: 'bow thread', parent_id: general, last_message_id: messages.get(activeThread).at(-1).id }] }),
    listArchivedThreads: async (channelId, options) => {
      calls.push(['archived', channelId, options.archivedAfter]);
      if (channelId !== forum) return { threads: [] };
      return { threads: [
        { id: archivedToday, guild_id: guildId, type: 11, name: 'morning bug', parent_id: forum, last_message_id: messages.get(archivedToday).at(-1).id, thread_metadata: { archived: true, archive_timestamp: new Date(todayStart + 4000000).toISOString() } },
        { id: archivedLongAgo, guild_id: guildId, type: 11, name: 'old bug', parent_id: forum, last_message_id: id(todayStart - 10 * 24 * 3600000), thread_metadata: { archived: true, archive_timestamp: new Date(todayStart - 9 * 24 * 3600000).toISOString() } },
      ].filter((thread) => !(Date.parse(thread.thread_metadata.archive_timestamp) < options.archivedAfter)) };
    },
    listMessages: async (channelId, { limit, after }) => {
      calls.push(['messages', channelId, after]);
      if (slowMs) await wait(slowMs);
      if (channelId === locked) { const error = new Error('Missing Access'); error.status = 403; throw error; }
      const newer = (messages.get(channelId) || []).filter((message) => BigInt(message.id) > BigInt(after)).sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1)).slice(0, limit);
      return newer.reverse();
    },
  };
  const account = { id: 'reader', client };
  const service = { accounts: [account], accountById: () => account, resolveGuild: async (requested) => ({ account, guild: { id: requested } }) };
  return { service, client, calls, ids: { general, idle, voice, forum, locked, activeThread, archivedToday } };
}

test('calendar days resolve to local midnight, including across DST', () => {
  assert.equal(startOfDay('Asia/Manila', now), todayStart);
  assert.equal(startOfDay('Asia/Manila', now, -1), todayStart - 24 * 3600000);
  assert.equal(new Date(startOfDay('America/New_York', Date.parse('2026-03-08T12:00:00Z'))).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.deepEqual(activityWindow({ day: 'yesterday', timeZone: 'Asia/Manila' }, now), { start: todayStart - 24 * 3600000, end: todayStart });
  assert.throws(() => activityWindow({ hours: 24 * 8, timeZone: 'UTC' }, now), /at most 7 days/);
});

test('a day summary reads only active channels, pages history, includes archived threads and skips bots', async () => {
  const { service, client, calls, ids } = server();
  clearActivityCache(client);
  const result = await readServerActivity(service, { guildId, day: 'today', timeZone: 'Asia/Manila' }, { now: () => now });
  assert.equal(result.window.since, new Date(todayStart).toISOString());
  const fetched = new Set(calls.filter(([kind]) => kind === 'messages').map(([, channelId]) => channelId));
  assert.ok(!fetched.has(ids.idle), 'idle channels are never fetched');
  assert.equal(calls.filter(([kind, channelId]) => kind === 'messages' && channelId === ids.general).length, 2, '150 messages page in two requests');
  assert.deepEqual(calls.filter(([kind]) => kind === 'archived').map(([, channelId]) => channelId).sort(), [ids.forum, ids.general, ids.locked].sort(), 'archive discovery skips long-idle text channels but always checks forums');
  const byId = Object.fromEntries(result.channels.map((channel) => [channel.channelId, channel]));
  assert.equal(byId[ids.general].messageCount, 150);
  assert.ok(!byId[ids.general].transcript.includes('outside the window'));
  assert.ok(!byId[ids.general].transcript.includes('build passed'));
  assert.equal(result.botMessagesSkipped, 1);
  assert.equal(byId[ids.archivedToday].parentName, 'bugs', 'a thread archived this morning is still summarized');
  assert.equal(byId[ids.activeThread].thread, true);
  assert.equal(byId[ids.voice].transcript, `[00:30|${(todayStart + 1800000) / 1000}] lewi: voice chat note :pog: for @Valk`);
  assert.equal(byId[ids.voice].firstAtUnix, (todayStart + 1800000) / 1000);
  assert.equal(result.window.sinceUnix, todayStart / 1000);
  assert.deepEqual(byId[ids.general].participants.map((participant) => [participant.name, participant.messages]), [['valk', 75], ['lewi', 75]]);
  assert.deepEqual(result.skipped, [{ channelId: ids.locked, name: 'locked', reason: 'no access' }]);
  assert.equal(result.messageCount, 154);
  assert.equal(result.partial, false);
  assert.equal(byId[ids.activeThread].transcript, `[00:40|${(todayStart + 2400000) / 1000}] valk: thread reply about the bow / and one more thought`, 'consecutive turns from one author merge');
});

test('keywords filter recent messages locally, and drill-downs reuse cached history', async () => {
  const { service, client, calls, ids } = server();
  clearActivityCache(client);
  const filtered = await readServerActivity(service, { guildId, day: 'today', timeZone: 'Asia/Manila', keywords: ['FATE'] }, { now: () => now });
  assert.deepEqual(filtered.channels.map((channel) => [channel.channelId, channel.messageCount]).sort(), [[ids.archivedToday, 1], [ids.general, 150]].sort());
  const before = calls.filter(([kind]) => kind === 'messages').length;
  const drill = await readServerActivity(service, { guildId, day: 'today', timeZone: 'Asia/Manila', channelIds: [ids.general], includeBots: true }, { now: () => now + 1000 });
  const newCalls = calls.filter(([kind]) => kind === 'messages').slice(before);
  assert.equal(newCalls.length, 2, 'only an incremental check per channel (general and its thread)');
  assert.ok(newCalls.every(([, , after]) => BigInt(after) > BigInt(snowflakeAt(todayStart))), 'incremental reads start after the cached newest message');
  assert.deepEqual(drill.channels.map((channel) => channel.channelId).sort(), [ids.activeThread, ids.general].sort());
  assert.equal(drill.channels.find((channel) => channel.channelId === ids.general).messageCount, 151, 'bots included on request');
});

test('large days shrink to the character budget and say what was shortened', async () => {
  const { service, client } = server();
  clearActivityCache(client);
  const result = await readServerActivity(service, { guildId, day: 'today', timeZone: 'Asia/Manila', maxCharacters: 2000 }, { now: () => now });
  const characters = result.channels.reduce((sum, channel) => sum + channel.transcript.length, 0);
  assert.ok(characters <= 2000 + result.channels.length * 1500);
  assert.equal(result.partial, true);
  assert.ok(result.channels.find((channel) => channel.name === 'general').omittedEarlierLines > 0);
  assert.match(result.channels.find((channel) => channel.name === 'general').transcript, /general message 149/, 'the most recent lines are kept');
});

test('a slow API returns partial results at the deadline instead of failing', async () => {
  const { service, client } = server({ slowMs: 40 });
  clearActivityCache(client);
  const result = await readServerActivity(service, { guildId, day: 'today', timeZone: 'Asia/Manila' }, { now: () => now, deadlineMs: 60, concurrency: 1 });
  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((entry) => entry.reason.startsWith('not read')) || result.channels.some((channel) => channel.incomplete));
});

test('Nova reads activity only in its own server and uses the configured owner time zone', async () => {
  const { service, client, ids } = server();
  clearActivityCache(client);
  const scoped = createDiscordReadTools(service, { channelId: ids.general, guildId, directMessages: false }, { timeZone: 'Asia/Manila' });
  await assert.rejects(() => scoped.call('discord_read_activity', { guildId: otherGuildId, day: 'today' }), /only read their own server/);
  await assert.rejects(() => scoped.call('discord_read_activity', { guildId, accountId: 'other' }));
  const result = JSON.parse((await scoped.call('discord_read_activity', { guildId, hours: 2, channelIds: ['200000000000000999'] })).contentItems[0].text);
  assert.equal(result.window.timeZone, 'Asia/Manila');
  assert.deepEqual(result.skipped, [{ channelId: '200000000000000999', reason: 'not a readable channel in this server' }]);
});

test('keyword search fetches later pages concurrently and keeps result order', async () => {
  let active = 0;
  let peak = 0;
  const account = { id: 'reader', client: { searchGuildMessages: async (_, { offset, limit }) => {
    active += 1; peak = Math.max(peak, active);
    await wait(10);
    active -= 1;
    return { total_results: 100, messages: Array.from({ length: limit }, (_, index) => [{ id: String(300000000000000000n + BigInt(offset + index)), channel_id: '200000000000000001', content: `hit ${offset + index}`, author: user('valk') }]) };
  } } };
  const result = await searchMessages({ accountForGuild: async () => account, accountById: () => account }, { guildId, query: 'fate', limit: 100 });
  assert.equal(result.messages.length, 100);
  assert.equal(result.pagesFetched, 4);
  assert.ok(peak > 1, 'pages after the first run in parallel');
  assert.deepEqual(result.messages.slice(0, 3).map((message) => message.content), ['hit 0', 'hit 1', 'hit 2']);
  assert.equal(result.messages.at(-1).content, 'hit 99');
  assert.equal(result.nextOffset, null);
});
