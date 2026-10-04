import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createChannelRuntime } from '../src/proactive/channel-runtime.mjs';
import { createCodexResponder } from '../src/proactive/codex-responder.mjs';
import { createNovaSettings } from '../src/proactive/nova-settings.mjs';
import { createDeliveryJournal } from '../src/proactive/delivery-journal.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

const owner = '291140236979732480';
const guildId = '1229046849520926720';
const channelId = '1241494817049936024';
const anotherChannelId = '1241494817049936025';
const bot = { id: '1555935515809939477', username: 'Nova' };
const messageId = '1555972640768790731';

async function fixture({ serverOptions } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nova-channel-integration-'));
  const settingsStore = createNovaSettings({ filename: join(directory, 'settings', 'nova.json') });
  const deliveryRoot = join(directory, 'delivery');
  const transport = fakeCodexServer(serverOptions);
  const messages = new Map();
  const channels = new Map([channelId, anotherChannelId].map((id) => [id, { id, type: 0, guild_id: guildId, name: `channel-${id}` }]));
  const sent = [];
  let nextMessage = 1666000000000000000n;
  const client = {
    getGuild: async (id) => ({ id, name: 'Guild' }), getChannel: async (id) => channels.get(id),
    getMessage: async (id, selected) => { assert.equal(messages.get(selected).channel_id, id); return messages.get(selected); },
    listMessages: async (id) => [...messages.values()].filter((message) => message.channel_id === id),
    listGuildEmojis: async () => [], listGuildStickers: async () => [], getGuildMember: async () => ({ roles: [] }),
    triggerTyping: async () => {}, addReaction: async () => {}, removeOwnReaction: async () => {}, deleteMessage: async () => {}, editMessage: async () => {},
    sendMessage: async (id, payload) => { const receipt = { id: String(++nextMessage), channel_id: id, guild_id: guildId, content: payload.content || '', author: { id: bot.id, username: 'Nova', bot: true } }; sent.push(receipt); return receipt; },
  };
  const account = { id: 'fixture', client };
  const service = { accounts: [account], accountById: (id) => { assert.equal(id, 'fixture'); return account; },
    resolveChannel: async (id, guild) => { assert.equal(guild, guildId); return { account, channel: channels.get(id) }; },
    resolveGuild: async () => ({ account, guild: { id: guildId } }),
  };
  const runtimes = [];
  async function create(selected = channelId, extra = {}, options = {}) {
    const source = await readFile(new URL('../src/proactive/channel-runtime.mjs', import.meta.url), 'utf8');
    assert.ok(source.includes('responderFactory'), 'Channel runtime must expose the offline responder factory hook before this test can run');
    const runtime = await createChannelRuntime(service, { accountId: 'fixture', guildId, channelId: selected, batchWindowMs: 1, cooldownMs: 0, maxRepliesPerMinute: 100, ...extra }, bot,
      { memoryRoot: directory, settingsStore, deliveryRoot, responderFactory: (preferences) => createCodexResponder({ ...preferences, spawnImpl: transport.spawnImpl }), ...options });
    runtimes.push(runtime);
    return runtime;
  }
  return { directory, settingsStore, deliveryRoot, transport, channels, messages, sent, create, cleanup: async () => { await Promise.allSettled(runtimes.map((runtime) => runtime.close())); await rm(directory, { recursive: true, force: true }); } };
}

function incoming(overrides = {}) { return { id: messageId, guild_id: guildId, channel_id: channelId, content: `<@${bot.id}> What changed?`, author: { id: owner, username: 'Owner', bot: false }, mentions: [{ id: bot.id }], ...overrides }; }
async function settled(runtime, field = 'replyBatches') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const statistics = runtime.status().statistics;
    if (statistics.errors) throw new Error(statistics.lastError);
    if (statistics[field] && !statistics.generating && !statistics.queued) return;
    await wait(2);
  }
  throw new Error('The offline conversation did not settle');
}

test('channel factories pool Codex workers while retaining per-channel threads and settings', async () => {
  const example = await fixture();
  try {
    await example.settingsStore.configureConversation('fixture', channelId, { model: 'first-model', reasoningEffort: 'low' }, owner);
    await example.settingsStore.configureConversation('fixture', anotherChannelId, { model: 'second-model', reasoningEffort: 'high' }, owner);
    const [first, second] = await Promise.all([example.create(), example.create(anotherChannelId)]);
    assert.equal(example.transport.launches.length, 1);
    assert.notEqual(first.status().conversation.threadId, second.status().conversation.threadId);
    assert.equal(first.status().conversation.model, 'first-model');
    assert.equal(second.status().conversation.model, 'second-model');
    await first.close();
    assert.equal(example.transport.children[0].exitCode, null);
    assert.equal(await second.receive(incoming({ channel_id: anotherChannelId })), true);
    await settled(second);
    assert.equal(second.status().conversation.turns, 1);
  } finally { await example.cleanup(); }
});

test('owner setting changes survive recreation and ordinary research does not rewrite approved memory', async () => {
  const example = await fixture();
  try {
    const runtime = await example.create();
    await runtime.control({ action: 'model', value: 'saved-model', userId: owner });
    await runtime.control({ action: 'effort', value: 'high', userId: owner });
    await runtime.control({ action: 'fast', value: 'off', userId: owner });
    await assert.rejects(runtime.control({ action: 'model', value: 'attacker-model', userId: '1666000000000000001' }), /Only the owner/);
    const filename = runtime.status().memoryFile;
    const approved = '# Nova memory\n\n- Explicitly approved fact.\n';
    await writeFile(filename, approved);
    await runtime.close();
    const replacement = await example.create();
    assert.equal(replacement.status().conversation.model, 'saved-model');
    assert.equal(replacement.status().conversation.reasoningEffort, 'high');
    assert.equal(replacement.status().conversation.requestedServiceTier, 'default');
    example.messages.set(messageId, incoming());
    assert.equal(await replacement.receive(incoming()), true);
    await settled(replacement);
    assert.equal(await readFile(filename, 'utf8'), approved);
    const turn = example.transport.requests.filter((request) => request.method === 'turn/start').at(-1);
    assert.equal(JSON.parse(turn.params.input[0].text).approvedMemory, approved);
  } finally { await example.cleanup(); }
});

test('durable owner ingress is reclaimed through recovery instead of being lost to duplicate suppression', async () => {
  const example = await fixture();
  try {
    const journal = await createDeliveryJournal({ accountId: 'fixture', channelId, root: example.deliveryRoot });
    await journal.claimIngress(incoming());
    await journal.close();
    example.messages.set(messageId, incoming());
    const runtime = await example.create(undefined, {}, { warm: false });
    assert.equal(await runtime.receive(incoming()), false);
    assert.equal(example.transport.launches.length, 0);
    await runtime.recover();
    await settled(runtime);
    await runtime.close();
    const restored = await createDeliveryJournal({ accountId: 'fixture', channelId, root: example.deliveryRoot });
    try { assert.deepEqual(await restored.pendingIngress(), []); }
    finally { await restored.close(); }
    assert.equal(example.transport.requests.filter((request) => request.method === 'turn/start').length, 1);
  } finally { await example.cleanup(); }
});

test('recovery refuses messages that no longer belong to the owner without starting a model', async () => {
  const example = await fixture();
  try {
    const journal = await createDeliveryJournal({ accountId: 'fixture', channelId, root: example.deliveryRoot });
    await journal.claimIngress(incoming());
    await journal.close();
    example.messages.set(messageId, incoming({ author: { id: '1666000000000000001' } }));
    const runtime = await example.create(undefined, {}, { warm: false });
    await runtime.recover();
    assert.equal(example.transport.launches.length, 0);
    await runtime.close();
    const restored = await createDeliveryJournal({ accountId: 'fixture', channelId, root: example.deliveryRoot });
    try { assert.deepEqual(await restored.pendingIngress(), []); }
    finally { await restored.close(); }
  } finally { await example.cleanup(); }
});

test('startup failure releases its journal lease and warm responder resources', async () => {
  const example = await fixture();
  let closed = 0;
  try {
    await assert.rejects(example.create(undefined, {}, { responderFactory: () => Object.assign(async () => {}, { warmup: async () => { throw new Error('Fixture warmup failed'); }, close: async () => { closed += 1; } }) }), /Fixture warmup failed/);
    assert.equal(closed, 1);
    assert.equal((await readdir(example.deliveryRoot)).some((name) => name.endsWith('.lock')), false);
    const journal = await createDeliveryJournal({ accountId: 'fixture', channelId, root: example.deliveryRoot });
    await journal.close();
  } finally { await example.cleanup(); }
});

test('foreign server channels and owner messages from other scopes are rejected before model work', async () => {
  const example = await fixture();
  try {
    example.channels.set(channelId, { id: channelId, type: 0, guild_id: '1666000000000000001' });
    await assert.rejects(example.create(undefined, {}, { warm: false }), /does not belong/);
    assert.equal(example.transport.launches.length, 0);
    const runtime = await example.create(anotherChannelId, {}, { warm: false });
    assert.equal(await runtime.receive(incoming()), false);
    assert.equal(await runtime.receive(incoming({ channel_id: anotherChannelId, author: { id: '1666000000000000002' } })), false);
    assert.equal(example.transport.launches.length, 0);
  } finally { await example.cleanup(); }
});

test('pausing pending owner work settles durable ingress as cancelled rather than replaying it later', async () => {
  const example = await fixture();
  try {
    const runtime = await example.create(undefined, { batchWindowMs: 60000 }, { warm: false });
    assert.equal(await runtime.receive(incoming()), true);
    await runtime.control({ action: 'pause', userId: owner });
    await runtime.close();
    const restored = await createDeliveryJournal({ accountId: 'fixture', channelId, root: example.deliveryRoot });
    try { assert.deepEqual(await restored.pendingIngress(), []); }
    finally { await restored.close(); }
    assert.equal(example.transport.launches.length, 0);
  } finally { await example.cleanup(); }
});

test('normal runtime shutdown joins queued ingress finalization before releasing the delivery journal', async () => {
  const example = await fixture();
  try {
    const runtime = await example.create(undefined, { batchWindowMs: 60000 }, { warm: false });
    assert.equal(await runtime.receive(incoming()), true);
    await runtime.close();
    const restored = await createDeliveryJournal({ accountId: 'fixture', channelId, root: example.deliveryRoot });
    try { assert.deepEqual(await restored.pendingIngress(), []); }
    finally { await restored.close(); }
    assert.equal(example.transport.launches.length, 0);
  } finally { await example.cleanup(); }
});
