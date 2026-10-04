import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { searchMessagesBatch } from '../src/search.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';

const guildId = '100000000000000001';
const otherGuildId = '100000000000000002';
const channelId = '200000000000000001';
const otherChannelId = '200000000000000002';
const foreignChannelId = '200000000000000003';

function fixture({ fail = null } = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const message = (id, content, channel = channelId) => ({ id, channel_id: channel, content, author: { id: '400000000000000001', username: 'Valk' }, attachments: [], embeds: [] });
  const account = { id: 'reader', client: {
    getChannel: async (id) => ({ id, guild_id: id === foreignChannelId ? otherGuildId : guildId, type: 0 }),
    searchGuildMessages: async (_, parameters) => {
      calls.push(parameters);
      active += 1; peak = Math.max(peak, active);
      await wait(5);
      active -= 1;
      if (parameters.content === fail) throw new Error('Search index unavailable');
      if (parameters.content === 'fate') return { total_results: 2, messages: [[message('300000000000000002', 'fate is good now')], [message('300000000000000001', 'fate buff '.repeat(100))]] };
      if (parameters.content === 'buff') return { total_results: 1, messages: [[message('300000000000000001', 'fate buff '.repeat(100))]] };
      return { total_results: 0, messages: [] };
    },
  } };
  const service = { accounts: [account], accountById: () => account, accountForGuild: async () => account, resolveGuild: async (id) => ({ account, guild: { id } }) };
  return { service, calls, peak: () => peak };
}

test('batch search runs bounded concurrent searches and merges duplicate hits', async () => {
  const { service, calls, peak } = fixture();
  const result = await searchMessagesBatch(service, { guildId, channelIds: [channelId], searches: [{ query: 'fate' }, { query: 'buff', channelIds: [otherChannelId] }, { query: 'nerf' }, { query: 'hero' }, { query: 'moon' }] });
  assert.ok(peak() <= 3, 'at most three searches run at once');
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.limit === 25), 'one small page per search by default');
  assert.deepEqual(calls.find((call) => call.content === 'buff').channel_id, [otherChannelId], 'per-search channels override the shared filter');
  assert.deepEqual(calls.find((call) => call.content === 'fate').channel_id, [channelId]);
  assert.equal(result.uniqueMessages, 2);
  assert.deepEqual(result.messages.map((message) => [message.id, message.matchedSearches]), [['300000000000000002', [0]], ['300000000000000001', [0, 1]]]);
  assert.ok(result.messages[1].content.length <= 601, 'contents are compacted');
  assert.deepEqual(result.searches.map((search) => [search.query, search.returned, search.totalResults]), [['fate', 2, 2], ['buff', 1, 1], ['nerf', 0, 0], ['hero', 0, 0], ['moon', 0, 0]]);
});

test('one failing search reports its error without discarding the others', async () => {
  const { service } = fixture({ fail: 'buff' });
  const result = await searchMessagesBatch(service, { guildId, searches: [{ query: 'fate' }, { query: 'buff' }] });
  assert.equal(result.searches[1].error, 'Search index unavailable');
  assert.equal(result.searches[0].returned, 2);
  assert.equal(result.uniqueMessages, 2);
  await assert.rejects(() => searchMessagesBatch(service, { guildId, searches: [] }), /1 to 10/);
  await assert.rejects(() => searchMessagesBatch(service, { guildId, searches: [{ query: 'x' }], limitPerSearch: 101 }), /limitPerSearch/);
});

test('Nova batch search stays inside its server and strips routing from continuations', async () => {
  const { service, calls } = fixture();
  const tools = createDiscordReadTools(service, { channelId, guildId, directMessages: false });
  await assert.rejects(() => tools.call('discord_search_batch', { guildId: otherGuildId, searches: [{ query: 'fate' }] }), /only read their own server/);
  await assert.rejects(() => tools.call('discord_search_batch', { guildId, searches: [{ query: 'fate', channelIds: [foreignChannelId] }] }), /does not belong/);
  await assert.rejects(() => tools.call('discord_search_batch', { guildId, accountId: 'other', searches: [{ query: 'fate' }] }));
  assert.equal(calls.length, 0);
  const result = JSON.parse((await tools.call('discord_search_batch', { guildId, searches: [{ query: 'fate' }] })).contentItems[0].text);
  assert.equal(result.uniqueMessages, 2);
  for (const search of result.searches) if (search.continuation) assert.equal(search.continuation.accountId, undefined);
});
