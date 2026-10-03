import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordService } from '../src/service.mjs';
import { searchMessages } from '../src/search.mjs';
import { browseMessages } from '../src/message-browser.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const base = 300000000000000000n;
const history = Array.from({ length: 500 }, (_, index) => ({ id: String(base + BigInt(index)), channel_id: channelId, content: `message ${index}`, author: { id: '400000000000000001', username: 'person' } }));

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixture({ searchPage } = {}) {
  const requests = [];
  const waits = [];
  const discord = new DiscordService({
    accounts: [{ id: 'reader', token: 'mock-token' }], maxRetries: 1,
    sleep: async (delay) => { waits.push(delay); },
    fetchImpl: async (input) => {
      const url = new URL(input);
      const path = url.pathname.replace('/api/v10', '');
      requests.push(url);
      if (path === '/users/@me') return json({ id: '500000000000000001', username: 'Nova' });
      if (path === '/users/@me/guilds') return json([{ id: guildId, name: 'Guild' }]);
      if (path === `/guilds/${guildId}`) return json({ id: guildId, name: 'Guild' });
      if (path === `/guilds/${guildId}/messages/search`) {
        if (searchPage) return searchPage(url, requests);
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        return json({ total_results: history.length, messages: history.slice(offset, offset + limit).map((message) => [{ ...message, hit: true }]) });
      }
      if (path === `/channels/${channelId}`) return json({ id: channelId, guild_id: guildId, name: 'general', type: 0 });
      const match = path.match(new RegExp(`^/channels/${channelId}/messages/(\\d+)$`));
      if (match) return history.find((message) => message.id === match[1]) ? json(history.find((message) => message.id === match[1])) : json({ message: 'Unknown Message' }, 404);
      if (path === `/channels/${channelId}/messages`) {
        const limit = Number(url.searchParams.get('limit'));
        const before = url.searchParams.get('before');
        const after = url.searchParams.get('after');
        const around = url.searchParams.get('around');
        let matches;
        if (before) matches = history.filter((message) => BigInt(message.id) < BigInt(before)).slice(-limit);
        else if (after) matches = history.filter((message) => BigInt(message.id) > BigInt(after)).slice(0, limit);
        else if (around) {
          const position = history.findIndex((message) => message.id === around);
          const start = Math.max(0, position - Math.floor(limit / 2));
          matches = history.slice(start, position + Math.ceil(limit / 2));
        } else matches = history.slice(-limit);
        return json([...matches].reverse());
      }
      throw new Error(`Unexpected fixture route ${path}`);
    },
  });

  return { discord, requests, waits };
}

test('server search gathers 250 native matches using 25-result pages and gives a continuation', async () => {
  const { discord, requests } = fixture();
  const result = await searchMessages(discord, { guildId, query: 'message' });
  const searches = requests.filter((url) => url.pathname.endsWith('/messages/search'));
  assert.equal(result.messages.length, 250);
  assert.equal(searches.length, 10);
  assert.ok(searches.every((url) => Number(url.searchParams.get('limit')) <= 25));
  assert.equal(result.nextOffset, 250);
  assert.equal(result.continuation.query, 'message');
  assert.equal(result.messages[0].url, `https://discord.com/channels/${guildId}/${channelId}/${history[0].id}`);
});

test('short search pages do not stop pagination and offsets advance by the requested size', async () => {
  const { discord, requests } = fixture({
    searchPage: (url) => {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const page = offset === 0 ? history.slice(0, 2) : history.slice(offset, offset + limit);
      return json({ total_results: 500, messages: page.map((message) => [message]) });
    },
  });
  const result = await searchMessages(discord, { guildId, limit: 30 });
  const offsets = requests.filter((url) => url.pathname.endsWith('/messages/search')).map((url) => Number(url.searchParams.get('offset')));
  assert.equal(result.messages.length, 30);
  assert.deepEqual(offsets, [0, 25, 50]);
});

test('search excludes surrounding non-hits, deduplicates matches and preserves false filters', async () => {
  const { discord, requests } = fixture({
    searchPage: () => json({ total_results: 3, messages: [[{ ...history[0], hit: false }, { ...history[1], hit: true }], [{ ...history[1], hit: true }, history[2]]] }),
  });
  const result = await searchMessages(discord, { guildId, limit: 3, pinned: false, channelIds: [channelId, channelId], authorIds: ['400000000000000001'] });
  assert.deepEqual(result.messages.map((message) => message.id), [history[1].id, history[2].id]);
  const url = requests.find((url) => url.pathname.endsWith('/messages/search'));
  assert.equal(url.searchParams.get('pinned'), 'false');
  assert.deepEqual(url.searchParams.getAll('channel_id'), [channelId]);
});

test('search retries an index-building response instead of reporting an empty result', async () => {
  let attempts = 0;
  const { discord, waits } = fixture({
    searchPage: () => ++attempts === 1 ? json({ code: 110000, retry_after: 2 }, 202) : json({ total_results: 1, messages: [[history[0]]] }),
  });
  const result = await searchMessages(discord, { guildId, limit: 1 });
  assert.equal(result.messages.length, 1);
  assert.deepEqual(waits, [2000]);
});

test('search stops at the Discord offset boundary and does not falsely claim completion', async () => {
  const { discord } = fixture({ searchPage: () => json({ total_results: 20000, messages: [history.slice(0, 25)] }) });
  const result = await searchMessages(discord, { guildId, offset: 9975, limit: 250 });
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.offsetLimitReached, true);
  assert.equal(result.nextOffset, null);
});

test('jumping to a message collects contiguous surrounding context and navigation cursors', async () => {
  const { discord } = fixture();
  const result = await browseMessages(discord, { url: `https://discord.com/channels/${guildId}/${channelId}/${history[250].id}`, limit: 250 });
  assert.equal(result.structured.anchor.id, history[250].id);
  assert.equal(result.structured.messages.length, 250);
  const positions = result.structured.messages.map((message) => Number(BigInt(message.id) - base));
  assert.ok(positions.every((position, index) => index === 0 || position === positions[index - 1] + 1));
  assert.equal(result.structured.navigation.older.before, result.structured.messages[0].id);
  assert.equal(result.structured.navigation.newer.after, result.structured.messages.at(-1).id);
});

test('history browsing pages before and after cursors without overlaps', async () => {
  const { discord } = fixture();
  const older = await browseMessages(discord, { channelId, before: history[400].id, limit: 250 });
  assert.deepEqual(older.structured.messages.map((message) => message.id), history.slice(150, 400).map((message) => message.id));
  const newer = await browseMessages(discord, { channelId, after: history[50].id, limit: 250 });
  assert.deepEqual(newer.structured.messages.map((message) => message.id), history.slice(51, 301).map((message) => message.id));
});

test('short around windows near either channel boundary fill from available history', async () => {
  const { discord } = fixture();
  const recent = await browseMessages(discord, { channelId, messageId: history.at(-1).id, limit: 250 });
  assert.deepEqual(recent.structured.messages.map((message) => message.id), history.slice(-250).map((message) => message.id));
  const early = await browseMessages(discord, { channelId, messageId: history[0].id, limit: 250 });
  assert.deepEqual(early.structured.messages.map((message) => message.id), history.slice(0, 250).map((message) => message.id));
});

test('latest history grabs 250 messages and deleted anchors remain an error', async () => {
  const { discord } = fixture();
  const result = await browseMessages(discord, { channelId, limit: 250 });
  assert.deepEqual(result.structured.messages.map((message) => message.id), history.slice(-250).map((message) => message.id));
  await assert.rejects(() => browseMessages(discord, { channelId, messageId: '300000000000009999' }), /404/);
});

test('invalid cursors and search limits are rejected before requesting Discord', async () => {
  const { discord, requests } = fixture();
  await assert.rejects(() => browseMessages(discord, { channelId, before: history[1].id, after: history[2].id }), /only one/);
  await assert.rejects(() => searchMessages(discord, { guildId, limit: 251 }), /between 1 and 250/);
  assert.equal(requests.length, 0);
});
