import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createServerMentions } from '../src/proactive/server-mentions.mjs';
import { createGateway } from '../src/proactive/gateway.mjs';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { createReplyScheduler } from '../src/proactive/reply-scheduler.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';
import { createChannelRuntime } from '../src/proactive/channel-runtime.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const botUserId = '300000000000000001';
let nextId = 400000000000000000n;
function incoming(properties = {}) {
  return { id: String(++nextId), guild_id: guildId, channel_id: channelId, author: { id: directMessageOwnerId }, content: `<@${botUserId}> hello`, mentions: [{ id: botUserId }], ...properties };
}

test('all-server routing creates isolated conversations lazily across guilds, channels and threads', async () => {
  const created = [];
  const delivered = [];
  let references = 0;
  const watcher = createServerMentions({ botUserId,
    resolveReplyAuthor: async () => { references += 1; return botUserId; },
    createRuntime: async (guild, channel) => {
      created.push({ guild, channel });
      return { receive: async (message) => { delivered.push(message); return true; }, close: async () => {}, status: () => ({ guildId: guild, channelId: channel, statistics: { queued: 0, generating: false } }) };
    },
  });
  try {
    assert.equal(created.length, 0);
    assert.equal(await watcher.receive(incoming({ author: { id: '500000000000000001' }, message_reference: { message_id: '600000000000000001' } })), false);
    assert.equal(await watcher.receive(incoming({ content: 'ordinary owner chatter', mentions: [] })), false);
    assert.equal(await watcher.receive(incoming({ guild_id: null })), false);
    assert.equal(references, 0);
    assert.equal(created.length, 0);
    await watcher.receive(incoming());
    await watcher.receive(incoming({ channel_id: '200000000000000002' }));
    await watcher.receive(incoming({ guild_id: '100000000000000002', channel_id: '200000000000000003' }));
    await watcher.receive(incoming({ content: 'reply without mention', mentions: [], message_reference: { message_id: '600000000000000001' } }));
    assert.equal(created.length, 3);
    assert.equal(delivered.length, 4);
    assert.equal(references, 1);
    assert.equal(delivered.at(-1).referenceAuthorId, botUserId);
    assert.equal(watcher.status().conversations.length, 3);
  } finally { await watcher.close(); }
});

test('concurrent first pings share runtime creation and failed initialization can recover', async () => {
  let created = 0;
  const watcher = createServerMentions({ botUserId, createRuntime: async () => {
    created += 1; await setTimeout(5);
    if (created === 1) throw new Error('Temporary lookup failure');
    return { receive: async () => true, close: async () => {}, status: () => ({ statistics: { queued: 0, generating: false } }) };
  } });
  try {
    const failed = await Promise.allSettled([watcher.receive(incoming()), watcher.receive(incoming())]);
    assert.ok(failed.every((result) => result.status === 'rejected'));
    assert.equal(created, 1);
    assert.equal(await watcher.receive(incoming()), true);
    assert.equal(created, 2);
  } finally { await watcher.close(); }
});

test('idle conversation eviction closes the oldest idle worker', async () => {
  const closed = [];
  const watcher = createServerMentions({ botUserId, maxIdleConversations: 1, createRuntime: async (guild, channel) => ({
    receive: async () => true, close: async () => { closed.push(channel); }, status: () => ({ channelId: channel, statistics: { generating: false, queued: 0 } }),
  }) });
  try {
    await watcher.receive(incoming());
    await setTimeout(2);
    await watcher.receive(incoming({ channel_id: '200000000000000002' }));
    for (let attempt = 0; attempt < 50 && !closed.length; attempt += 1) await setTimeout(2);
    assert.deepEqual(closed, [channelId]);
    assert.equal(watcher.status().conversations[0].channelId, '200000000000000002');
  } finally { await watcher.close(); }
});

test('active conversations are retained while excess idle conversations are evicted', async () => {
  const closed = [];
  const watcher = createServerMentions({ botUserId, maxIdleConversations: 1, createRuntime: async (guild, channel) => ({
    receive: async () => true, close: async () => { closed.push(channel); }, status: () => ({ channelId: channel, statistics: { generating: channel === channelId, queued: 0 } }),
  }) });
  try {
    await watcher.receive(incoming());
    await watcher.receive(incoming({ channel_id: '200000000000000002' }));
    await setTimeout(2);
    await watcher.receive(incoming({ channel_id: '200000000000000003' }));
    for (let attempt = 0; attempt < 50 && !closed.length; attempt += 1) await setTimeout(2);
    assert.deepEqual(closed, ['200000000000000002']);
    assert.ok(watcher.status().conversations.some((conversation) => conversation.channelId === channelId));
  } finally { await watcher.close(); }
});

test('stopping during lazy initialization closes the new runtime without forwarding the ping', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let forwarded = 0;
  let closed = 0;
  const watcher = createServerMentions({ botUserId, createRuntime: async () => {
    await gate;
    return { receive: async () => { forwarded += 1; }, close: async () => { closed += 1; }, status: () => ({ statistics: { generating: false, queued: 0 } }) };
  } });
  const pending = watcher.receive(incoming());
  await Promise.resolve();
  await Promise.resolve();
  const stopping = watcher.close();
  release();
  await stopping;
  assert.equal(await pending, false);
  assert.equal(forwarded, 0);
  assert.equal(closed, 1);
});

test('server engines reject other users before reference lookups, context, typing or generation in every mode', async () => {
  for (const mode of ['mentions', 'questions', 'all']) {
    let calls = 0;
    const engine = createProactiveEngine({ botUserId, guildId, channelId, mode,
      resolveReplyAuthor: async () => { calls += 1; }, getContext: async () => { calls += 1; },
      generateReply: async () => { calls += 1; }, startTyping: () => { calls += 1; return () => {}; }, sendReplies: async () => { calls += 1; },
    });
    try {
      assert.equal(await engine.receive(incoming({ author: { id: '500000000000000001' }, message_reference: { message_id: '600000000000000001' } })), false);
      await setTimeout(2);
      assert.equal(calls, 0);
    } finally { engine.stop(); }
  }
});

test('the all-server Gateway forwards only owner guild messages without a selected guild or channel', async () => {
  let client;
  const received = [];
  const gateway = createGateway({ token: 'fixture', allServers: true, onMessage: (message) => { received.push(message); }, onError: () => {},
    clientFactory: (options) => { client = new Client(options); return client; },
  });
  try {
    assert.ok(client.options.intents.has(GatewayIntentBits.GuildMessages));
    for (const [guild, channel, author] of [[guildId, channelId, directMessageOwnerId], ['100000000000000002', '200000000000000002', directMessageOwnerId], [guildId, channelId, '500000000000000001'], [null, channelId, directMessageOwnerId]]) {
      client.emit(Events.MessageCreate, { id: String(++nextId), guildId: guild, channelId: channel, author: { id: author, username: 'user' },
        content: `<@${botUserId}>`, createdAt: new Date(), mentions: { users: new Map(), repliedUser: null }, attachments: new Map(), reference: null, webhookId: null });
    }
    await Promise.resolve();
    assert.equal(received.length, 2);
    assert.notEqual(received[0].guild_id, received[1].guild_id);
  } finally { gateway.close(); }
});

test('all-server replies share concurrency, cooldown and model-attempt limits', async () => {
  let current = 0;
  const starts = [];
  const schedule = createReplyScheduler({ cooldownMs: 5, maxRepliesPerMinute: 2, now: () => current, sleep: async (delay) => { current += delay; } });
  await Promise.all(Array.from({ length: 3 }, () => schedule(async () => { starts.push(current); current += 1; })));
  assert.deepEqual(starts, [0, 6, 60000]);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(() => schedule(async () => { throw new Error('Should not run'); }, cancel.signal), /abort/i);
});

test('channel runtimes use the selected service account and owner memory commands work without warming Codex', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-runtime-'));
  const sent = [];
  const account = { id: 'reader', client: {
    getGuild: async () => ({ id: guildId, name: 'Guild' }),
    getChannel: async () => ({ id: channelId, guild_id: guildId, name: 'channel', type: 0 }),
    sendMessage: async (_, message) => { sent.push(message); return { id: '700000000000000001', content: message.content }; },
  } };
  const service = { accountById: (id) => { assert.equal(id, 'reader'); return account; }, resolveChannel: async () => ({ account, channel: { id: channelId, guild_id: guildId } }) };
  let runtime;
  try {
    runtime = await createChannelRuntime(service, { accountId: 'reader', guildId, channelId, listenerId: 'fixture' }, { id: botUserId, username: 'Nova' }, { warm: false, memoryRoot: directory });
    assert.equal(runtime.status().conversation.threadId, undefined);
    assert.equal(await runtime.receive(incoming({ content: `<@${botUserId}> remember this: approved` })), true);
    for (let attempt = 0; attempt < 50 && !sent.length; attempt += 1) await setTimeout(2);
    assert.equal(sent.length, 1);
    assert.match(await readFile(runtime.status().memoryFile, 'utf8'), /approved/);
    assert.equal(runtime.status().conversation.threadId, undefined);
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});
