import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { createCodexResponder } from '../src/proactive/codex-responder.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';
import { DiscordApiClient } from '../src/discord-api.mjs';

const guildId = '100000000000000001';
const otherGuildId = '100000000000000002';
const channelId = '200000000000000001';
const otherChannelId = '200000000000000002';
const dmId = '200000000000000003';
const foreignDmId = '200000000000000004';
const messageId = '300000000000000001';
const authorId = '400000000000000001';
const scope = { channelId: dmId, guildId: null, directMessages: true };
const context = { ...scope, expressions: { emojis: [], stickers: [] }, allowedGifUrls: [], recentMessages: [], triggerMessages: [] };

function fixture() {
  const calls = [];
  const channels = new Map([
    [channelId, { id: channelId, guild_id: guildId, type: 0 }],
    [otherChannelId, { id: otherChannelId, guild_id: otherGuildId, type: 0 }],
    [dmId, { id: dmId, type: 1, recipients: [{ id: directMessageOwnerId }] }],
    [foreignDmId, { id: foreignDmId, type: 1, recipients: [{ id: authorId }] }],
  ]);
  const message = { id: messageId, channel_id: channelId, author: { id: authorId, username: 'Valk' }, content: 'SJW hotbar spec' };
  const account = { id: 'default', token: 'fixture-private-token', client: {
    searchGuildMembers: async (...args) => { calls.push(['members', ...args]); return [{ user: { id: authorId, username: 'Valk' }, nick: 'Valk' }]; },
    getChannel: async (id) => channels.get(id),
    searchGuildMessages: async (...args) => { calls.push(['search', ...args]); return { total_results: 100, messages: [[message]] }; },
    getMessage: async () => message,
    listMessages: async () => [message],
  } };
  const service = { accounts: [account], accountById: () => account,
    resolveGuild: async (id) => { calls.push(['guild', id]); return { account, guild: { id } }; },
    resolveChannel: async (id) => ({ account, channel: channels.get(id) }),
    listServers: async () => ({ servers: [{ id: guildId, name: 'AV Dev' }, { id: otherGuildId, name: 'Other' }], accounts: [] }),
    normalizeReadSource: ({ url, guildId, channelId, messageId }) => {
      if (url) {
        assert.ok(!guildId && !channelId && !messageId, 'URL must not be mixed with IDs');
        const parts = new URL(url).pathname.split('/');
        return { guildId: parts[2] === '@me' ? null : parts[2], channelId: parts[3], messageId: parts[4] || null, url };
      }
      return { guildId: guildId || null, channelId, messageId: messageId || null, url: null };
    },
  };
  return { service, calls };
}

function contents(result) { return JSON.parse(result.contentItems[0].text); }

test('owner DM tools resolve names, search other servers, preserve continuation and open message URL context', async () => {
  const { service, calls } = fixture();
  const tools = createDiscordReadTools(service, scope);
  assert.equal(tools.definitions.length, 12);
  assert.ok(tools.definitions.every((tool) => tool.type === 'function' && tool.inputSchema.additionalProperties === false));
  assert.equal(contents(await tools.call('discord_list_servers', {})).servers.length, 2);
  const members = contents(await tools.call('discord_find_members', { guildId, query: 'Valk' }));
  assert.equal(members.members[0].id, authorId);
  const search = contents(await tools.call('discord_search_messages', { guildId: otherGuildId, query: 'SJW', authorIds: [authorId], limit: 1 }));
  assert.ok(search.continuation);
  await tools.call('discord_search_messages', search.continuation);
  assert.ok(calls.some(([kind, guild]) => kind === 'search' && guild === otherGuildId));
  const around = contents(await tools.call('discord_message_context', { url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`, limit: 1 }));
  assert.equal(around.anchor.id, messageId);
  assert.equal(around.messages[0].content, 'SJW hotbar spec');
  await tools.call('discord_browse_messages', around.navigation.older);
});

test('server tools reject other guilds, guessed cross-server channels and every DM before message history reads', async () => {
  const { service, calls } = fixture();
  const tools = createDiscordReadTools(service, { channelId, guildId, directMessages: false });
  assert.deepEqual(contents(await tools.call('discord_list_servers', {})).servers.map((server) => server.id), [guildId]);
  await assert.rejects(() => tools.call('discord_search_messages', { guildId: otherGuildId }), /only read their own server/);
  await assert.rejects(() => tools.call('discord_browse_messages', { channelId: otherChannelId }), /only read their own server/);
  await assert.rejects(() => tools.call('discord_browse_messages', { guildId, channelId: otherChannelId }), /does not belong/);
  await assert.rejects(() => tools.call('discord_browse_messages', { channelId: dmId }), /Only this owner DM/);
  await assert.rejects(() => tools.call('discord_search_messages', { guildId, channelIds: [otherChannelId] }), /does not belong/);
  assert.equal(calls.filter(([kind]) => kind === 'search').length, 0);
});

test('tools never expose writes, accept forged routing fields, or read another private conversation', async () => {
  const { service } = fixture();
  const tools = createDiscordReadTools(service, scope);
  await assert.rejects(() => tools.call('discord_send_message', {}), /unavailable/);
  await assert.rejects(() => tools.call('discord_list_servers', { accountId: 'other' }), /Unrecognized key/);
  await assert.rejects(() => tools.call('discord_browse_messages', { channelId: foreignDmId }), /Only this owner DM/);
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(() => tools.call('discord_list_servers', {}, cancellation.signal), /abort/i);
  assert.equal(tools.errorMessage(new Error('private fixture-private-token')), 'private [redacted]');
});

test('dynamic read calls work inside a warm ephemeral conversation and report only factual tool activity', async () => {
  const { service } = fixture();
  const readTools = createDiscordReadTools(service, scope);
  const server = fakeCodexServer({ toolCalls: [
    { tool: 'discord_list_servers' }, { tool: 'discord_find_members', arguments: { guildId, query: 'Valk' } },
    { tool: 'discord_search_messages', arguments: { guildId, query: 'SJW', limit: 1 } },
    { tool: 'discord_send_message' }, { tool: 'discord_list_servers', params: { threadId: 'foreign-thread' } },
  ], events: [{ method: 'item/reasoning/textDelta', params: { delta: 'never disclose this internal reasoning' } }] });
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl, scope, readTools });
  const progress = [];
  try {
    await respond(context, undefined, { onProgress: async (event) => { progress.push(event); } });
    const start = server.requests.find((request) => request.method === 'thread/start').params;
    assert.equal(start.dynamicTools.length, 12);
    assert.equal(start.config.features.shell_tool, false);
    assert.equal(start.config.permissions[start.permissions].network.enabled, false);
    assert.ok(server.toolResponses.slice(0, 3).every((response) => response.result.success));
    assert.ok(server.toolResponses.slice(3).every((response) => !response.result.success));
    assert.deepEqual(progress.filter((event) => event.stage === 'started').map((event) => event.toolName), ['discord_list_servers', 'discord_find_members', 'discord_search_messages']);
    assert.equal(progress.at(-1).resultCount, 1);
    assert.deepEqual(progress.find((event) => event.toolName === 'discord_search_messages').arguments, { guildId, query: 'SJW', limit: 1 }, 'progress gets tool arguments so it can describe the search');
    assert.ok(!JSON.stringify(progress).includes('internal reasoning'));
    assert.ok(!JSON.stringify(start).includes(service.accounts[0].token));
  } finally { await respond.close(); }
});

test('dynamic requests deduplicate call IDs, bound each turn and return recoverable tool errors', async () => {
  let executions = 0;
  const readTools = { definitions: [], has: () => true, errorMessage: (error) => error.message, call: async () => {
    executions += 1;
    if (executions === 2) throw new Error('Search indexing not ready');
    return { success: true, contentItems: [{ type: 'inputText', text: '{}' }] };
  } };
  const calls = [{ tool: 'reader', params: { callId: 'same' } }, { tool: 'reader', params: { callId: 'same' } }, ...Array.from({ length: 25 }, (_, index) => ({ tool: 'reader', arguments: { query: index } }))];
  const server = fakeCodexServer({ toolCalls: calls });
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl, scope, readTools });
  try {
    await respond(context);
    assert.equal(executions, 24);
    assert.deepEqual(server.toolResponses[0].result, server.toolResponses[1].result);
    assert.equal(server.toolResponses[2].result.contentItems[0].text, 'Search indexing not ready');
    assert.match(server.toolResponses.at(-1).result.contentItems[0].text, /tool limit/);
  } finally { await respond.close(); }
});

test('cancelling a search stops before the next page and forwards the signal to indexing waits', async () => {
  const { service } = fixture();
  const cancellation = new AbortController();
  let pages = 0;
  service.accounts[0].client.searchGuildMessages = async (requestedGuildId, parameters, options) => {
    assert.equal(requestedGuildId, guildId);
    assert.equal(options.signal, cancellation.signal);
    pages += 1;
    cancellation.abort();
    return { total_results: 1000, messages: Array.from({ length: 25 }, (_, index) => [{
      id: String(BigInt(messageId) + BigInt(index)), channel_id: channelId, author: { id: authorId }, content: 'fixture',
    }]) };
  };
  const tools = createDiscordReadTools(service, scope);
  await assert.rejects(tools.call('discord_search_messages', { guildId, limit: 250 }, cancellation.signal), { name: 'AbortError' });
  assert.equal(pages, 1);
});

test('cancelling channel browsing stops before another latest, cursor or context page', async () => {
  for (const cursors of [{}, { before: messageId }, { after: messageId }, { around: messageId }]) {
    const { service } = fixture();
    const cancellation = new AbortController();
    let pages = 0;
    service.accounts[0].client.listMessages = async () => {
      pages += 1;
      cancellation.abort();
      return Array.from({ length: 100 }, (_, index) => ({
        id: String(BigInt(messageId) + BigInt(index)), channel_id: channelId, author: { id: authorId }, content: 'fixture',
      }));
    };
    const tools = createDiscordReadTools(service, scope);
    await assert.rejects(tools.call('discord_browse_messages', { guildId, channelId, limit: 250, ...cursors }, cancellation.signal), { name: 'AbortError' });
    assert.equal(pages, 1, `Unexpected extra page with ${JSON.stringify(cursors)}`);
  }
});

test('server discovery omits foreign expected guilds and global counts while preserving relevant errors', async () => {
  const { service } = fixture();
  const discovery = {
    servers: [{ id: guildId, name: 'AV Dev' }, { id: otherGuildId, name: 'Private Other Server' }],
    accounts: [{ accountId: 'default', bot: { id: authorId, username: 'Nova' }, guildCount: 4, error: { message: 'Discovery unavailable' } }],
    expectedMissing: [{ accountId: 'default', guildId }, { accountId: 'default', guildId: otherGuildId }],
  };
  service.listServers = async () => discovery;
  const tools = createDiscordReadTools(service, { channelId, guildId, directMessages: false });
  const result = contents(await tools.call('discord_list_servers', {}));
  assert.deepEqual(result.servers, [discovery.servers[0]]);
  assert.deepEqual(result.expectedMissing, [discovery.expectedMissing[0]]);
  assert.deepEqual(result.accounts[0].error, discovery.accounts[0].error);
  assert.equal(Object.hasOwn(result.accounts[0], 'guildCount'), false);
  assert.ok(!JSON.stringify(result).includes(otherGuildId));
  assert.ok(!JSON.stringify(result).includes('Private Other Server'));
  const dmTools = createDiscordReadTools(service, scope);
  assert.deepEqual(contents(await dmTools.call('discord_list_servers', {})), discovery);
});

test('cancelling an indexing retry interrupts the production sleep before another request', async () => {
  const cancellation = new AbortController();
  let requests = 0;
  let markSleeping;
  const sleepStarted = new Promise((resolve) => { markSleeping = resolve; });
  const client = new DiscordApiClient({ accountId: 'default', token: 'fixture' });
  const productionSleep = client.sleep;
  client.sleep = (...args) => { const sleeping = productionSleep(...args); markSleeping(); return sleeping; };
  client.get = async () => {
    requests += 1;
    return { code: 110000, retry_after: 0.25 };
  };
  const outcome = client.searchGuildMessages(guildId, {}, { signal: cancellation.signal }).then(() => 'completed', (error) => error.name);
  await sleepStarted;
  cancellation.abort();
  const settled = await Promise.race([outcome, new Promise((resolve) => process.nextTick(() => resolve('pending')))]);
  assert.equal(settled, 'AbortError', 'Indexing cancellation must settle without waiting for the retry timer');
  assert.equal(requests, 1);
});

test('unexpected approval requests are rejected and fail the conversation without activity updates', async () => {
  const { service } = fixture();
  const readTools = createDiscordReadTools(service, scope);
  const server = fakeCodexServer({ toolCalls: [{ method: 'item/commandExecution/requestApproval', tool: 'discord_list_servers' }] });
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl, scope, readTools });
  const progress = [];
  try {
    await assert.rejects(respond(context, undefined, { onProgress: async (event) => { progress.push(event); } }), /unsupported tool or approval/);
    assert.equal(server.toolResponses.length, 1);
    assert.equal(server.toolResponses[0].error.code, -32601);
    assert.equal(progress.length, 0);
  } finally { await respond.close(); }
});

test('image context yields bounded inputImage items while text results retain navigation', async () => {
  const { service } = fixture();
  service.imageContent = async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }], warnings: [] });
  const result = await createDiscordReadTools(service, scope).call('discord_message_context', { guildId, channelId, messageId, limit: 1, includeImages: true });
  assert.equal(result.contentItems[1].type, 'inputImage');
  assert.equal(result.contentItems[1].imageUrl, 'data:image/png;base64,YQ==');
  assert.ok(contents(result).navigation.older);
});

test('oversized results keep previews and conversation-local retrievable pages', async () => {
  const { service } = fixture();
  service.listServers = async () => ({ servers: Array.from({ length: 100 }, (_, index) => ({ id: String(index), description: 'source '.repeat(200) })), accounts: [] });
  const tools = createDiscordReadTools(service, scope, { maxResultBytes: 4096 });
  const first = contents(await tools.call('discord_list_servers', {}));
  assert.ok(first.partial); assert.ok(first.resultHandle);
  const page = contents(await tools.call('read_tool_result', { handle: first.resultHandle, length: 2000 }));
  assert.match(page.text, /source/); assert.equal(page.nextOffset, 2000);
  await assert.rejects(createDiscordReadTools(service, scope).call('read_tool_result', { handle: first.resultHandle }), /expired/);
});

test('topic research playbook preserves source links and performs bounded context reads', async () => {
  const { service } = fixture();
  const result = contents(await createDiscordReadTools(service, scope).call('discord_research_topic', { guildId, query: 'SJW', limit: 1, contextLimit: 1 }));
  assert.equal(result.conversations.length, 1);
  assert.equal(result.search.messages[0].url, `https://discord.com/channels/${guildId}/${channelId}/${messageId}`);
  assert.equal(result.untrustedContent, true);
});

test('retrieval handles evict after eight results expire and keep Unicode JSON pages inside the byte budget', async () => {
  const { service } = fixture();
  let currentTime = 1000;
  service.listServers = async () => ({ servers: [{ id: guildId, description: '😀漢字'.repeat(4000) }], accounts: [] });
  const tools = createDiscordReadTools(service, scope, { maxResultBytes: 4096, now: () => currentTime });
  const first = contents(await tools.call('discord_list_servers', {}));
  const page = await tools.call('read_tool_result', { handle: first.resultHandle, length: 20000 });
  assert.ok(Buffer.byteLength(page.contentItems[0].text) <= 4096);
  assert.ok(contents(page).nextOffset);
  assert.equal(contents(page).resultHandle, undefined, 'Reading a page must not recursively create another result handle');
  for (let index = 0; index < 8; index += 1) await tools.call('discord_list_servers', {});
  await assert.rejects(tools.call('read_tool_result', { handle: first.resultHandle }), /expired/);
  const latest = contents(await tools.call('discord_list_servers', {})); currentTime += 600001;
  await assert.rejects(tools.call('read_tool_result', { handle: latest.resultHandle }), /expired/);
});
