import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNovaCommand, novaSlashCommand, readNovaInteraction, createControlButtons } from '../src/proactive/controls.mjs';
import { createGateway } from '../src/proactive/gateway.mjs';
import { createNovaSettings } from '../src/proactive/nova-settings.mjs';
import { createDaemonControls } from '../src/proactive/daemon-controls.mjs';
import { createChannelRuntime } from '../src/proactive/channel-runtime.mjs';
import { directMessageOwnerId as owner } from '../src/proactive/target.mjs';

const botId = '1555935515809939477';
const guildId = '1229046849520926720';
const channelId = '1241494817049936024';
const dmId = '1555972640768790729';

function interaction(action, values = {}, { userId = owner, guild = guildId, channel = channelId } = {}) {
  const replies = [];
  return { commandName: 'nova', user: { id: userId }, guildId: guild, channelId: channel, isButton: () => false, isChatInputCommand: () => true,
    options: { getSubcommand: () => action, getString: (name) => values[name] ?? null }, replies,
    reply: async (payload) => replies.push({ type: 'reply', ...payload }), deferReply: async (payload) => replies.push({ type: 'defer', ...payload }), editReply: async (payload) => replies.push({ type: 'edit', ...payload }) };
}

function gatewayFixture(options = {}) {
  const controls = [];
  const messages = [];
  const posts = [];
  const errors = [];
  const client = new EventEmitter();
  Object.assign(client, { user: { id: botId, username: 'Nova' }, guilds: { cache: new Map() }, destroy: async () => {}, login: async () => { client.emit(Events.ClientReady); }, rest: { post: async (path, options) => { posts.push({ path, ...options }); return { id: dmId }; } } });
  const gateway = createGateway({ token: 'offline fixture', allServers: true, onControl: async (request) => { controls.push(request); return { action: request.action, privateStatus: 'owner detail' }; }, onMessage: async (message) => messages.push(message), onError: (error) => errors.push(error), clientFactory: () => client, ...options });
  return { gateway, client, controls, messages, posts, errors };
}

function sdkMessage(content, overrides = {}) {
  return { id: '1555972640768790731', guildId, channelId, author: { id: owner, username: 'Owner', bot: false }, content, createdAt: new Date(), mentions: { users: new Map() }, attachments: new Map(), ...overrides };
}

async function settled() { await wait(5); }

test('only raw owner command syntax is parsed; quotations, code, forwarded snapshots and another bot mention are data', async () => {
  assert.deepEqual(parseNovaCommand(`<@${botId}> nova pause`, botId), { action: 'pause' });
  assert.deepEqual(parseNovaCommand('nova steer only review mobile controls', botId), { action: 'steer', value: 'only review mobile controls' });
  for (const text of ['> nova pause', '```\nnova pause\n```', 'Valk said "nova pause"', `<@100000000000000001> nova pause`, 'nova pause everything']) assert.equal(parseNovaCommand(text, botId), null);
  const fixture = gatewayFixture();
  try {
    fixture.client.emit(Events.MessageCreate, sdkMessage('', { messageSnapshots: new Map([['forward', { content: 'nova pause', attachments: new Map() }]]) }));
    fixture.client.emit(Events.MessageCreate, sdkMessage('nova pause', { author: { id: '100000000000000001', username: 'Other', bot: false } }));
    await settled();
    assert.equal(fixture.controls.length, 0);
    assert.equal(fixture.messages.length, 1);
    assert.equal(fixture.messages[0].message_snapshots[0].message.content, 'nova pause');
  } finally { await fixture.gateway.close(); }
});

test('native slash definitions remain within Discord limits and preserve model, research and digest options', () => {
  const command = novaSlashCommand();
  assert.equal(command.name, 'nova');
  assert.ok(command.options.length <= 25);
  assert.equal(new Set(command.options.map((entry) => entry.name)).size, command.options.length);
  for (const entry of command.options) assert.equal(entry.type, 1);
  assert.equal(command.options.find((entry) => entry.name === 'steer').options[0].required, true);
  assert.deepEqual(readNovaInteraction(interaction('model', { value: 'gpt-6.1-sol' })), { action: 'model', value: 'gpt-6.1-sol', userId: owner, guildId, channelId });
  const research = readNovaInteraction(interaction('research', { request: 'Find hotbar decisions', guild: guildId, channel: channelId }, { guild: null, channel: dmId }));
  assert.equal(research.value, 'Find hotbar decisions');
  assert.equal(research.guildId, guildId);
  assert.equal(research.channelId, channelId);
  const digest = readNovaInteraction(interaction('digest', { operation: 'add', configuration: JSON.stringify({ guildId, query: 'hotbar', authorIds: [owner], intervalMinutes: 30 }) }));
  assert.deepEqual(digest.configuration, { guildId, query: 'hotbar', authorIds: [owner], intervalMinutes: 30 });
  assert.equal(readNovaInteraction(interaction('digest', { operation: 'add', configuration: 'invalid' })).action, 'help');
});

test('buttons are single-use, owner-only, conversation-scoped and expire without consuming unauthorized attempts', () => {
  let clock = 0;
  const buttons = createControlButtons({ now: () => clock, ttlMs: 100 });
  const scope = { guildId, channelId, messageId: '1555972640768790732', triggerMessageId: '1555972640768790731' };
  const [row] = buttons.create(scope, ['remember', 'retry']);
  const remember = row.components[0].custom_id;
  assert.throws(() => buttons.consume(remember, { userId: '100000000000000001', channelId }), /owner/);
  assert.throws(() => buttons.consume(remember, { userId: owner, channelId: dmId }), /conversation/);
  const command = buttons.consume(remember, { userId: owner, channelId });
  assert.equal(command.action, 'remember');
  assert.equal(command.value, scope.messageId);
  assert.throws(() => buttons.consume(remember, { userId: owner, channelId }), /expired/);
  clock = 101;
  assert.throws(() => buttons.consume(row.components[1].custom_id, { userId: owner, channelId }), /expired/);
  buttons.close();
});

test('SDK slash interactions execute in exactly one listener with private output; unauthorized interactions never invoke controls or the model', async () => {
  const server = gatewayFixture();
  const dm = gatewayFixture({ directMessages: true, allServers: false, channelId: dmId });
  try {
    const guildRequest = interaction('status');
    server.client.emit(Events.InteractionCreate, guildRequest);
    dm.client.emit(Events.InteractionCreate, guildRequest);
    const dmRequest = interaction('details', {}, { guild: null, channel: dmId });
    server.client.emit(Events.InteractionCreate, dmRequest);
    dm.client.emit(Events.InteractionCreate, dmRequest);
    const unauthorized = interaction('model', { value: 'other' }, { userId: '100000000000000001' });
    server.client.emit(Events.InteractionCreate, unauthorized);
    dm.client.emit(Events.InteractionCreate, unauthorized);
    await settled();
    assert.equal(server.controls.length, 1);
    assert.equal(dm.controls.length, 1);
    assert.equal(server.messages.length + dm.messages.length, 0);
    assert.equal(guildRequest.replies.filter((entry) => entry.type === 'defer').length, 1);
    assert.equal(dmRequest.replies.filter((entry) => entry.type === 'defer').length, 1);
    assert.equal(guildRequest.replies[0].flags, 64);
    assert.equal(dmRequest.replies[0].flags, 64);
    assert.deepEqual(unauthorized.replies, [{ type: 'reply', content: 'Nova controls are available only to the owner.', flags: 64 }]);
  } finally { await server.gateway.close(); await dm.gateway.close(); }
});

test('raw commands deliver their result only in owner DMs and do not enter model message handling', async () => {
  const fixture = gatewayFixture();
  try {
    fixture.client.emit(Events.MessageCreate, sdkMessage('nova status'));
    await settled();
    assert.equal(fixture.controls.length, 1);
    assert.equal(fixture.messages.length, 0);
    assert.deepEqual(fixture.posts[0], { path: '/users/@me/channels', body: { recipient_id: owner } });
    assert.equal(fixture.posts[1].path, `/channels/${dmId}/messages`);
    assert.deepEqual(fixture.posts[1].body.allowed_mentions, { parse: [] });
    assert.match(fixture.posts[1].body.content, /owner detail/);
  } finally { await fixture.gateway.close(); }
});

test('per-conversation pause and model settings survive cache eviction without affecting another channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-controls-settings-'));
  const filename = join(root, 'nova.json');
  try {
    let store = createNovaSettings({ filename });
    await assert.rejects(store.configureConversation('default', channelId, { paused: true }, '100000000000000001'), /owner/);
    await store.configureConversation('default', channelId, { paused: true, model: 'gpt-6.1-sol' }, owner);
    store = createNovaSettings({ filename });
    const replacement = await store.load('default', channelId);
    assert.equal(replacement.conversations[`default:${channelId}`].paused, true);
    const other = await store.load('default', dmId);
    assert.equal(other.conversations[`default:${dmId}`], undefined);
    await store.configureConversation('default', channelId, { paused: false }, owner);
    assert.equal((await store.load('default', channelId)).conversations[`default:${channelId}`].model, 'gpt-6.1-sol');
    assert.equal((await store.load('default', channelId)).conversations[`default:${channelId}`].paused, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('daemon control router rejects unauthorized users before selecting a conversation or job', async () => {
  let selected = 0;
  const controls = createDaemonControls({ service: {}, configuration: { accountId: 'default', allServers: true }, getRuntime: async () => { selected += 1; return { control: async () => ({ paused: true }) }; }, getStatus: () => ({ state: 'running' }), jobs: { list: () => [] } });
  await assert.rejects(controls.execute({ action: 'pause', userId: '100000000000000001', channelId, guildId }), /owner/);
  assert.equal(selected, 0);
  const result = await controls.execute({ action: 'pause', userId: owner, channelId, guildId });
  assert.equal(result.paused, true);
  assert.equal(selected, 1);
});

test('a recreated paused runtime rejects owner chat before context lookup or model invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-paused-runtime-'));
  let generations = 0;
  let contextReads = 0;
  const account = { id: 'default', client: { getGuild: async () => ({ id: guildId, name: 'Guild' }), getChannel: async () => ({ id: channelId, guild_id: guildId, type: 0 }), listMessages: async () => { contextReads += 1; return []; } } };
  const service = { accountById: () => account };
  const factory = () => {
    const generateReply = async () => { generations += 1; return { shouldReply: false, messages: [] }; };
    Object.assign(generateReply, { status: () => ({}), interrupt: async () => {}, close: async () => {} });
    return generateReply;
  };
  let runtime;
  try {
    const settingsStore = createNovaSettings({ filename: join(root, 'nova.json') });
    const configuration = { accountId: 'default', guildId, channelId };
    const options = { warm: false, memoryRoot: root, settingsStore, responderFactory: factory };
    runtime = await createChannelRuntime(service, configuration, { id: botId }, options);
    await runtime.control({ action: 'pause', userId: owner });
    await runtime.close();
    runtime = await createChannelRuntime(service, configuration, { id: botId }, { ...options, settingsStore: createNovaSettings({ filename: join(root, 'nova.json') }) });
    assert.equal(runtime.status().statistics.paused, true);
    assert.equal(await runtime.receive({ id: '1555972640768790750', channel_id: channelId, guild_id: guildId, author: { id: owner }, content: `<@${botId}> what changed?`, mentions: [{ id: botId }] }), false);
    assert.equal(generations, 0);
    assert.equal(contextReads, 0);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
