import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DiscordService } from '../src/service.mjs';
import { createDiscordMcpServer } from '../src/server.mjs';
import { forwardMessages } from '../src/messaging.mjs';
import { shapeMessage } from '../src/shapes.mjs';
import { createReplySender } from '../src/proactive/reply-sender.mjs';
import { createReplyStream } from '../src/proactive/reply-stream.mjs';
import { validateReplyPlan } from '../src/proactive/reply-validation.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const guildId = '100000000000000001';
const otherGuildId = '100000000000000002';
const channelId = '200000000000000001';
const sourceChannelId = '200000000000000002';
const foreignChannelId = '200000000000000003';
const dmId = '200000000000000004';
const firstId = '300000000000000001';
const secondId = '300000000000000002';
const botUserId = '500000000000000001';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixture({ failOn } = {}) {
  const sends = [];
  const service = new DiscordService({
    accounts: [{ id: 'reader', token: 'mock-token' }],
    fetchImpl: async (input, options) => {
      const path = new URL(input).pathname.replace('/api/v10', '');
      if (path === '/users/@me') return json({ id: botUserId, username: 'Nova', bot: true });
      if (path === '/users/@me/guilds') return json([{ id: guildId, name: 'Example' }]);
      if (path === `/channels/${channelId}`) return json({ id: channelId, guild_id: guildId, name: 'general', type: 0 });
      if (path === `/channels/${channelId}/messages` && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        sends.push(payload);
        if (payload.message_reference.message_id === failOn) return json({ message: 'Unknown Message' }, 404);
        return json({ id: `70000000000000000${sends.length}`, channel_id: channelId, content: '', author: { id: botUserId, username: 'Nova', bot: true },
          message_reference: payload.message_reference, message_snapshots: [{ message: { content: 'original', attachments: [{ id: '1', filename: 'clip.png', url: 'https://cdn.discordapp.com/clip.png' }] } }] });
      }
      throw new Error(`Unexpected route: ${path}`);
    },
  });
  return { service, sends };
}

test('forwards several messages in order as native forwards with stable nonces', async () => {
  const { service, sends } = fixture();
  const sleeps = [];
  const result = await forwardMessages(service, {
    channelId, batchId: 'share', intervalMs: 10,
    messages: [{ url: `https://discord.com/channels/${guildId}/${sourceChannelId}/${firstId}` }, { channelId: sourceChannelId, messageId: secondId }],
  }, { sleep: async (ms) => { sleeps.push(ms); } });

  assert.deepEqual(sends.map((payload) => payload.message_reference), [
    { type: 1, message_id: firstId, channel_id: sourceChannelId, guild_id: guildId, fail_if_not_exists: true },
    { type: 1, message_id: secondId, channel_id: sourceChannelId, fail_if_not_exists: true },
  ]);
  assert.deepEqual(sends.map((payload) => payload.nonce), ['share:f0', 'share:f1']);
  assert.ok(sends.every((payload) => payload.content === undefined && payload.enforce_nonce));
  assert.deepEqual(sleeps, [10]);
  assert.equal(result.sentMessages[0].source.messageId, firstId);
  assert.equal(result.sentMessages[0].message.forwarded[0].attachments[0].name, 'clip.png');
  assert.equal(result.sentMessages[0].message.replyTo, null);
});

test('forward batches reject duplicates and invalid sources, and report partial receipts', async () => {
  const { service, sends } = fixture({ failOn: secondId });
  await assert.rejects(() => forwardMessages(service, { channelId, messages: [] }), /1 to 10/);
  await assert.rejects(() => forwardMessages(service, { channelId, messages: [{ channelId: sourceChannelId }] }), /messageId/);
  await assert.rejects(() => forwardMessages(service, { channelId, messages: [{ channelId: sourceChannelId, messageId: firstId }, { channelId: sourceChannelId, messageId: firstId }] }), /only be forwarded once/);
  assert.equal(sends.length, 0);

  await assert.rejects(() => forwardMessages(service, { channelId, intervalMs: 0, messages: [{ channelId: sourceChannelId, messageId: firstId }, { channelId: sourceChannelId, messageId: secondId }] }), (error) => {
    assert.equal(error.sendStatus, 'rejected');
    assert.equal(error.failedMessageIndex, 1);
    assert.equal(error.sentMessages.length, 1);
    return true;
  });
});

test('discord_forward_messages is a write tool over MCP', async () => {
  const { service, sends } = fixture();
  const client = new Client({ name: 'forward-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createDiscordMcpServer(service).connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find((item) => item.name === 'discord_forward_messages');
    assert.equal(tool.annotations.readOnlyHint, false);
    const result = await client.callTool({ name: 'discord_forward_messages', arguments: { channelId, intervalMs: 0, messages: [{ channelId: sourceChannelId, messageId: firstId }] } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.sentMessages.length, 1);
    assert.equal(sends.length, 1);
  } finally { await client.close(); }
});

test('shapes forwarded messages with their source and snapshot instead of a reply', () => {
  const shaped = shapeMessage({ id: firstId, channel_id: channelId, message_reference: { type: 1, message_id: secondId, channel_id: sourceChannelId, guild_id: guildId }, message_snapshots: [{ message: { content: 'hi', attachments: [] } }] });
  assert.equal(shaped.replyTo, null);
  assert.deepEqual(shaped.forwardedFrom, { guildId, channelId: sourceChannelId, messageId: secondId });
  assert.deepEqual(shaped.forwarded, [{ content: 'hi', attachments: [], embeds: [] }]);
  assert.equal(shapeMessage({ id: firstId, message_reference: { message_id: secondId } }).replyTo, secondId);
});

test('Nova plans accept deduplicated forwards and drop them when not replying', () => {
  const forward = { channelId: sourceChannelId, messageId: firstId };
  assert.deepEqual(validateReplyPlan({ shouldReply: true, messages: [], reactions: [], files: [], forwards: [forward, forward] }, {}), { shouldReply: true, messages: [], forwards: [forward] });
  assert.deepEqual(validateReplyPlan({ shouldReply: false, messages: [], reactions: [], files: [], forwards: [forward] }, {}), { shouldReply: false, messages: [] });
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], forwards: [{ channelId: 'general', messageId: firstId }] }, {}));
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], forwards: Array.from({ length: 6 }, (_, index) => ({ channelId: sourceChannelId, messageId: `30000000000000001${index}` })) }, {}));

  const streamed = [];
  const stream = createReplyStream((message) => streamed.push(message));
  stream.push(JSON.stringify({ shouldReply: true, messages: [{ content: 'here', gifUrl: null, stickerIds: [] }], reactions: [], files: [], forwards: [forward] }));
  assert.equal(streamed.length, 1);
});

test('Nova forward sources follow the conversation reading scope', async () => {
  const channels = new Map([
    [sourceChannelId, { id: sourceChannelId, guild_id: guildId, type: 0 }],
    [foreignChannelId, { id: foreignChannelId, guild_id: otherGuildId, type: 0 }],
    [dmId, { id: dmId, type: 1, recipients: [{ id: directMessageOwnerId }] }],
  ]);
  const account = { id: 'reader', client: {} };
  const service = { accounts: [account],
    resolveGuild: async (id) => ({ account, guild: { id } }),
    resolveChannel: async (id) => ({ account, channel: channels.get(id) }),
    normalizeReadSource: ({ guildId: sourceGuildId, channelId: sourceChannel, messageId }) => ({ guildId: sourceGuildId || null, channelId: sourceChannel, messageId: messageId || null, url: null }),
  };
  const server = createDiscordReadTools(service, { channelId, guildId, directMessages: false });
  assert.deepEqual(await server.forwardSource({ channelId: sourceChannelId, messageId: firstId }), { guildId, channelId: sourceChannelId, messageId: firstId });
  await assert.rejects(() => server.forwardSource({ channelId: foreignChannelId, messageId: firstId }), /only read their own server/);
  await assert.rejects(() => server.forwardSource({ channelId: dmId, messageId: firstId }), /Only this owner DM/);

  const ownerDm = createDiscordReadTools(service, { channelId: dmId, guildId: null, directMessages: true });
  assert.equal((await ownerDm.forwardSource({ channelId: foreignChannelId, messageId: firstId })).guildId, otherGuildId);
});

test('Nova reply sender forwards through the scope check with journaled nonces and no reply reference', async () => {
  const payloads = [];
  const checked = [];
  const service = { resolveChannel: async () => ({ channel: { id: channelId, guild_id: guildId }, account: { id: 'reader', client: {
    sendMessage: async (_, payload) => { payloads.push(payload); return { id: `70000000000000000${payloads.length}`, content: '' }; },
  } } }) };
  const forwards = [{ channelId: sourceChannelId, messageId: firstId }, { channelId: sourceChannelId, messageId: secondId }];
  const trigger = { id: '400000000000000001', message_reference: { message_id: '400000000000000000' } };

  await assert.rejects(() => createReplySender(service, { guildId, channelId, listenerId: 'fixture' }).forwards(forwards, trigger), /unavailable/);
  assert.equal(payloads.length, 0);

  const send = createReplySender(service, { guildId, channelId, listenerId: 'fixture', forwardSource: async (forward) => { checked.push(forward.messageId); return { ...forward, guildId }; } });
  const result = await send.forwards(forwards, trigger);
  assert.deepEqual(checked, [firstId, secondId]);
  assert.equal(result.sentMessages.length, 2);
  assert.deepEqual(payloads.map((payload) => payload.nonce), [`${result.batchId}:w0`, `${result.batchId}:w1`]);
  assert.ok(payloads.every((payload) => payload.message_reference.type === 1 && payload.message_reference.guild_id === guildId && payload.allowed_mentions === undefined));
});

test('Nova engine posts forwards after the reply bubbles', async () => {
  const events = [];
  const forwards = [{ channelId: sourceChannelId, messageId: firstId }];
  const sendReplies = async (messages) => { events.push('message'); return { sentMessages: messages }; };
  sendReplies.forwards = async (items) => { events.push(`forward:${items.length}`); return { sentMessages: items }; };
  const engine = createProactiveEngine({
    botUserId, guildId, channelId, batchWindowMs: 5, cooldownMs: 0,
    resolveReplyAuthor: async () => botUserId,
    getContext: async () => ({ recentMessages: [] }),
    generateReply: async () => ({ shouldReply: true, messages: [{ content: 'here you go 👇' }], forwards }),
    sendReplies,
  });
  try {
    assert.equal(await engine.receive({ id: '400000000000000009', guild_id: guildId, channel_id: channelId, author: { id: directMessageOwnerId, bot: false }, content: `<@${botUserId}> forward that`, mentions: [] }), true);
    for (let attempt = 0; attempt < 200 && events.length < 2; attempt += 1) await setTimeout(5);
    assert.deepEqual(events, ['message', 'forward:1']);
    assert.equal(engine.status().forwards, 1);
    assert.equal(engine.status().sentMessages, 2);
  } finally { engine.stop(); }
});
