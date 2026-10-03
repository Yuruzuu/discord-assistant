import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DiscordService } from '../src/service.mjs';
import { createDiscordMcpServer } from '../src/server.mjs';
import { listExpressions, sendMessage } from '../src/messaging.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const stickerId = '300000000000000001';
const emojiId = '400000000000000001';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixture({ sendStatus = 200, rateLimitOnce = false } = {}) {
  const requests = [];
  let sendAttempts = 0;
  const service = new DiscordService({
    accounts: [{ id: 'reader', token: 'mock-token' }],
    fetchImpl: async (input, options) => {
      const path = new URL(input).pathname.replace('/api/v10', '');
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({ path, method: options.method, payload });
      if (path === '/users/@me') return json({ id: '500000000000000001', username: 'Nova', bot: true });
      if (path === '/users/@me/guilds') return json([{ id: guildId, name: 'Example' }]);
      if (path === `/guilds/${guildId}`) return json({ id: guildId, name: 'Example' });
      if (path === `/channels/${channelId}`) return json({ id: channelId, guild_id: guildId, name: 'general', type: 0 });
      if (path === `/guilds/${guildId}/emojis`) return json([
        { id: emojiId, name: 'wave', animated: false, available: true, roles: [] },
        { id: '400000000000000002', name: 'dance', animated: true, available: false, roles: ['600000000000000001'] },
      ]);
      if (path === `/guilds/${guildId}/stickers`) return json([{ id: stickerId, name: 'Hello', description: 'Greeting', tags: 'wave', format_type: 1, available: true }]);
      if (path === `/channels/${channelId}/messages` && options.method === 'POST') {
        sendAttempts += 1;
        if (rateLimitOnce && sendAttempts === 1) return json({ retry_after: 0.001 }, 429);
        if (sendStatus !== 200) return json({ message: 'Send failed' }, sendStatus);
        return json({
          id: '700000000000000001', channel_id: channelId, content: payload.content || '',
          author: { id: '500000000000000001', username: 'Nova', bot: true },
          sticker_items: payload.sticker_ids?.map((id) => ({ id, name: 'Hello', format_type: 1 })),
        });
      }
      throw new Error(`Unexpected route: ${path}`);
    },
  });

  return { service, requests, sends: () => requests.filter((request) => request.method === 'POST') };
}

test('lists static and animated emoji markup and server sticker IDs without writing', async () => {
  const { service, requests } = fixture();
  const result = await listExpressions(service, { guildId });

  assert.equal(result.emojis[0].markup, `<:wave:${emojiId}>`);
  assert.equal(result.emojis[1].markup, '<a:dance:400000000000000002>');
  assert.equal(result.emojis[1].available, false);
  assert.deepEqual(result.emojis[1].roleIds, ['600000000000000001']);
  assert.equal(result.stickers[0].id, stickerId);
  assert.equal(result.stickers[0].guildId, guildId);
  assert.ok(requests.every((request) => request.method === 'GET'));
});

test('expression kind filters avoid unnecessary requests', async () => {
  const { service, requests } = fixture();
  const result = await listExpressions(service, { guildId, kind: 'emojis' });

  assert.equal(result.emojis.length, 2);
  assert.deepEqual(result.stickers, []);
  assert.ok(requests.every((request) => !request.path.endsWith('/stickers')));
});

test('sends exact emoji content and stickers as the bot with mentions disabled', async () => {
  const { service, sends } = fixture();
  const content = `Hello <:wave:${emojiId}>`;
  const result = await sendMessage(service, { guildId, channelId, content, stickerIds: [stickerId], nonce: 'stable-send-id' });

  assert.equal(sends().length, 1);
  assert.deepEqual(sends()[0].payload, {
    content, sticker_ids: [stickerId], allowed_mentions: { parse: [] }, nonce: 'stable-send-id', enforce_nonce: true,
  });
  assert.equal(result.accountId, 'reader');
  assert.equal(result.message.bot, true);
  assert.equal(result.message.url, `https://discord.com/channels/${guildId}/${channelId}/700000000000000001`);
  assert.equal(result.message.stickers[0].id, stickerId);
});

test('supports sticker-only messages and explicit mention notifications', async () => {
  const { service, sends } = fixture();
  await sendMessage(service, { channelId, stickerIds: [stickerId] });
  assert.ok(!('content' in sends()[0].payload));
  assert.match(sends()[0].payload.nonce, /^[a-f0-9]{24}$/);

  await sendMessage(service, { channelId, content: 'Hello @everyone', allowMentions: true });
  assert.deepEqual(sends()[1].payload.allowed_mentions.parse, ['users', 'roles', 'everyone']);
});

test('rejects invalid sends before making any network request', async () => {
  const { service, requests } = fixture();
  await assert.rejects(() => sendMessage(service, { channelId, content: ' ' }), /content or at least one/);
  await assert.rejects(() => sendMessage(service, { channelId, content: 'a'.repeat(2001) }), /2000/);
  await assert.rejects(() => sendMessage(service, { channelId, stickerIds: [stickerId, stickerId, stickerId, stickerId] }), /at most 3/);
  await assert.rejects(() => sendMessage(service, { channelId, content: 'Hello', nonce: 'a'.repeat(26) }), /1 to 25/);

  assert.equal(requests.length, 0);
});

test('overlapping distinct sends are never coalesced', async () => {
  const { service, sends } = fixture();
  await Promise.all([
    sendMessage(service, { channelId, content: 'First' }),
    sendMessage(service, { channelId, content: 'Second' }),
  ]);

  assert.equal(sends().length, 2);
  assert.deepEqual(sends().map((request) => request.payload.content), ['First', 'Second']);
  assert.notEqual(sends()[0].payload.nonce, sends()[1].payload.nonce);
});

test('does not automatically resend after an ambiguous server failure', async () => {
  const { service, sends } = fixture({ sendStatus: 500 });
  await assert.rejects(() => sendMessage(service, { channelId, content: 'Hello' }), (error) => {
    assert.match(error.message, /send outcome is unknown/);
    assert.match(error.nonce, /^[a-f0-9]{24}$/);
    assert.equal(error.sendStatus, 'unknown');
    return true;
  });

  assert.equal(sends().length, 1);
});

test('an MCP send failure returns its nonce for a deliberate retry', async () => {
  const { service, sends } = fixture({ sendStatus: 500 });
  const server = createDiscordMcpServer(service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'discord_send_message', arguments: { channelId, content: 'Hello' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.nonce, sends()[0].payload.nonce);
    assert.equal(result.structuredContent.error.sendStatus, 'unknown');
    assert.equal(sends().length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('rate-limited send retries preserve the original payload and nonce', async () => {
  const { service, sends } = fixture({ rateLimitOnce: true });
  let current = 0;
  service.accounts[0].client.now = () => current;
  service.accounts[0].client.sleep = async (milliseconds) => { current += milliseconds; };
  await sendMessage(service, { channelId, content: 'Hello', nonce: 'stable-retry-id' });

  assert.equal(sends().length, 2);
  assert.deepEqual(sends()[0].payload, sends()[1].payload);
  assert.equal(current, 50);
});

test('send permission failure is reported without retrying the write', async () => {
  const { service, sends } = fixture({ sendStatus: 403 });
  await assert.rejects(() => sendMessage(service, { channelId, content: 'Hello' }), /403/);

  assert.equal(sends().length, 1);
});

test('MCP exposes read expression discovery and a separately annotated send tool', async () => {
  const { service, sends } = fixture();
  const server = createDiscordMcpServer(service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((tool) => tool.name === 'discord_list_expressions').annotations.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'discord_send_message').annotations.readOnlyHint, false);
    assert.equal(tools.find((tool) => tool.name === 'discord_send_message').annotations.idempotentHint, false);

    const sent = await client.callTool({ name: 'discord_send_message', arguments: { channelId, content: 'Hello' } });
    assert.equal(sent.structuredContent.message.content, 'Hello');
    assert.equal(sends().length, 1);

    const invalid = await client.callTool({ name: 'discord_send_message', arguments: { channelId } });
    assert.equal(invalid.isError, true);
    assert.equal(sends().length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
