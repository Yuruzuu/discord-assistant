import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { createGateway } from '../src/proactive/gateway.mjs';
import { createConversationContext } from '../src/proactive/context.mjs';
import { assertOwnerDirectMessageChannel, directMessageOwnerId } from '../src/proactive/target.mjs';
import { DiscordApiClient } from '../src/discord-api.mjs';

const channelId = '200000000000000001';
const botUserId = '300000000000000001';
const strangerId = '500000000000000001';
let nextMessage = 400000000000000001n;
function message(properties = {}) {
  return { id: String(nextMessage++), guild_id: null, channel_id: channelId, author: { id: directMessageOwnerId, bot: false }, content: 'hello', mentions: [], ...properties };
}

async function until(condition) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await setTimeout(5);
  assert.ok(condition(), 'Expected DM response did not arrive');
}

function engineFixture() {
  const generated = [];
  const sent = [];
  let contextCalls = 0;
  let referenceCalls = 0;
  const engine = createProactiveEngine({
    botUserId, channelId, directMessages: true, batchWindowMs: 5, cooldownMs: 0,
    resolveReplyAuthor: async () => { referenceCalls += 1; return botUserId; },
    getContext: async () => { contextCalls += 1; return { directMessages: true }; },
    generateReply: async (context) => { generated.push(context); return { shouldReply: true, messages: [{ content: 'hey!' }] }; },
    sendReplies: async (messages, trigger) => { sent.push({ messages, trigger }); return { sentMessages: messages }; },
  });

  return { engine, generated, sent, contextCalls: () => contextCalls, referenceCalls: () => referenceCalls };
}

test('owner DMs reply without a mention and keep native reply targets and deduplication', async () => {
  const { engine, generated, sent, referenceCalls } = engineFixture();
  try {
    const incoming = message({ message_reference: { message_id: '600000000000000001' } });
    assert.equal(await engine.receive(incoming), true);
    await until(() => sent.length === 1);
    assert.equal(sent[0].trigger.id, incoming.id);
    assert.equal(generated[0].triggerMessages[0].content, 'hello');
    assert.equal(referenceCalls(), 0);
    assert.equal(await engine.receive(incoming), false);
    await setTimeout(10);
    assert.equal(sent.length, 1);
  } finally { engine.stop(); }
});

test('other DM authors and guild messages cannot reach context lookup or generation', async () => {
  const { engine, generated, sent, contextCalls, referenceCalls } = engineFixture();
  try {
    for (const incoming of [
      message({ author: { id: strangerId }, mentions: [{ id: botUserId }], message_reference: { message_id: '600000000000000001' } }),
      message({ guild_id: '100000000000000001' }),
      message({ channel_id: '200000000000000002' }),
      message({ author: { id: botUserId, bot: true } }),
      message({ webhook_id: '700000000000000001' }),
    ]) assert.equal(await engine.receive(incoming), false);
    await setTimeout(10);
    assert.equal(contextCalls(), 0);
    assert.equal(referenceCalls(), 0);
    assert.equal(generated.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(engine.status().queued, 0);
  } finally { engine.stop(); }
});

test('the Gateway receives uncached DMs and discards unauthorized senders before its callback', async () => {
  let client;
  const received = [];
  const errors = [];
  const gateway = createGateway({
    token: 'mock-token', channelId, directMessages: true,
    onMessage: (message) => { received.push(message); }, onError: (error) => { errors.push(error); },
    clientFactory: (options) => {
      client = new Client(options);
      client.user = client.users._add({ id: botUserId, username: 'Nova', discriminator: '0', bot: true });
      return client;
    },
  });
  try {
    assert.equal(client.options.intents.bitfield, GatewayIntentBits.DirectMessages);
    assert.ok(client.options.partials.includes(Partials.Channel));
    assert.equal(client.channels.cache.size, 0);
    for (const authorId of [strangerId, directMessageOwnerId]) {
      client.actions.MessageCreate.handle({
        id: String(nextMessage++), channel_id: channelId, channel_type: 1, type: 0,
        author: { id: authorId, username: 'person', discriminator: '0' }, content: 'hi',
        timestamp: new Date().toISOString(), mentions: [], mention_roles: [], attachments: [], embeds: [],
      });
    }
    await Promise.resolve();
    assert.equal(received.length, 1);
    assert.equal(received[0].author.id, directMessageOwnerId);
    assert.equal(received[0].guild_id, null);
    assert.deepEqual(errors, []);
  } finally { gateway.close(); }
});

test('DM history includes only owner and bot messages, with no guild expression lookups', async () => {
  const history = [
    message({ author: { id: botUserId, username: 'Nova', bot: true } }),
    message({ content: 'hi https://media.tenor.com/owner.gif' }),
    message({ author: { id: strangerId }, content: 'https://media.tenor.com/stranger.gif' }),
  ];
  const context = await createConversationContext({ listMessages: async () => history }, {
    bot: { id: botUserId, username: 'Nova' }, channel: { id: channelId, type: 1 }, directMessages: true,
  })();
  assert.equal(context.ownerUserId, directMessageOwnerId);
  assert.equal(context.directMessages, true);
  assert.deepEqual(context.recentMessages.map((message) => message.authorId), [directMessageOwnerId, botUserId]);
  assert.deepEqual(context.expressions, { emojis: [], stickers: [] });
  assert.deepEqual(context.allowedGifUrls, ['https://media.tenor.com/owner.gif']);
  assert.equal(history[0].author.id, botUserId);
});

test('server context retains role-filtered expressions and its expression cache', async () => {
  let expressionReads = 0;
  const context = createConversationContext({
    listMessages: async () => [message()],
    listGuildEmojis: async () => { expressionReads += 1; return [{ id: '600000000000000001', name: 'wave', roles: ['allowed'] }, { id: '600000000000000002', name: 'locked', roles: ['denied'] }]; },
    listGuildStickers: async () => [], getGuildMember: async () => ({ roles: ['allowed'] }),
  }, { bot: { id: botUserId, username: 'Nova' }, guild: { id: '100000000000000001', name: 'Guild' }, channel: { id: channelId, name: 'general' } });
  assert.deepEqual((await context()).expressions.emojis.map((emoji) => emoji.name), ['wave']);
  assert.equal((await context()).serverName, 'Guild');
  assert.equal(expressionReads, 1);
});

test('DM channel setup rejects strangers, group DMs and guild channels', () => {
  assert.doesNotThrow(() => assertOwnerDirectMessageChannel({ type: 1, recipients: [{ id: directMessageOwnerId }] }));
  for (const channel of [
    { type: 1, recipients: [{ id: strangerId }] }, { type: 1, recipients: [{ id: directMessageOwnerId }, { id: strangerId }] },
    { type: 3, recipients: [{ id: directMessageOwnerId }] }, { type: 0 },
  ]) assert.throws(() => assertOwnerDirectMessageChannel(channel), /configured owner/);
});

test('DM channel creation uses the authenticated bot REST endpoint', async () => {
  let request;
  const client = new DiscordApiClient({ accountId: 'reader', token: 'mock-token', fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ id: channelId, type: 1, recipients: [{ id: directMessageOwnerId }] }));
  } });
  const channel = await client.createDirectMessageChannel(directMessageOwnerId);
  assert.equal(channel.id, channelId);
  assert.equal(request.options.method, 'POST');
  assert.equal(new URL(request.url).pathname, '/api/v10/users/@me/channels');
  assert.deepEqual(JSON.parse(request.options.body), { recipient_id: directMessageOwnerId });
});
