import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { validateReplyPlan } from '../src/proactive/reply-validation.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { createReplySender } from '../src/proactive/reply-sender.mjs';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';
import { createDeliveryJournal } from '../src/proactive/delivery-journal.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guildId = '100000000000000001';
const textChannelId = '200000000000000001';
const voiceChannelId = '200000000000000002';
const dmId = '200000000000000004';
const otherDmId = '200000000000000005';
const userId = '400000000000000001';
const botUserId = '500000000000000001';

test('channel messages are only accepted from the owner DM and only when replying', () => {
  const item = { channelId: textChannelId, content: `<@${userId}> good job!`, notify: true };
  assert.deepEqual(validateReplyPlan({ shouldReply: true, messages: [], channelMessages: [item] }, { directMessages: true }), { shouldReply: true, messages: [], channelMessages: [item] });
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], channelMessages: [item] }, { channelId: textChannelId, guildId }), /outside the owner DM/);
  assert.equal(validateReplyPlan({ shouldReply: false, messages: [], channelMessages: [item] }, { directMessages: true }).channelMessages, undefined);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], channelMessages: [{ ...item, content: '   ' }] }, { directMessages: true }), /empty/);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], channelMessages: [item, item, item, item] }, { directMessages: true }));
});

test('post targets must be server text channels reached from the owner DM, and private app reads block posting', async () => {
  const channels = { [textChannelId]: { id: textChannelId, guild_id: guildId, type: 0 }, [voiceChannelId]: { id: voiceChannelId, guild_id: guildId, type: 2 }, [otherDmId]: { id: otherDmId, type: 1 } };
  const service = { accounts: [], resolveChannel: async (id) => ({ account: { id: 'reader' }, channel: channels[id] }) };
  const connectedApps = { list: async () => ({}), call: async () => ({ text: 'email body' }) };
  const server = createDiscordReadTools(service, { channelId: textChannelId, guildId, directMessages: false });
  await assert.rejects(() => server.sendTarget(textChannelId), /Only the owner DM/);

  const dm = createDiscordReadTools(service, { channelId: dmId, guildId: null, directMessages: true }, { connectedApps });
  assert.equal((await dm.sendTarget(textChannelId)).channel.id, textChannelId);
  await assert.rejects(() => dm.sendTarget(voiceChannelId), /text channels and threads/);
  await assert.rejects(() => dm.sendTarget(otherDmId), /text channels and threads/);
  await assert.rejects(() => dm.sendTarget('general'), /valid channel/);
  await dm.call('apps_call_tool', { tool: 'gmail.search_emails', arguments: {} });
  await assert.rejects(() => dm.sendTarget(textChannelId), /after reading connected-app data/);
  dm.beginTurn();
  assert.equal((await dm.sendTarget(textChannelId)).channel.id, textChannelId);
});

test('the sender posts through the scope check, pings only mentioned users on request and journals against the DM', async () => {
  const posts = [];
  const journal = [];
  const target = { account: { id: 'reader', client: { sendMessage: async (channel, payload) => { posts.push({ channel, payload }); return { id: `70000000000000000${posts.length}`, channel_id: channel, content: payload.content }; } } }, channel: { id: textChannelId, guild_id: guildId } };
  const deliveryJournal = { lookup: async () => null, begin: async (id, metadata) => journal.push({ id, metadata }), record: async () => {}, unknown: async () => {}, resolve: async () => {} };
  const trigger = { id: '300000000000000001' };
  await assert.rejects(() => createReplySender({}, { channelId: dmId, listenerId: 'fixture' }).channelMessages([{ channelId: textChannelId, content: 'hi', notify: false }], trigger), /unavailable/);

  const send = createReplySender({}, { channelId: dmId, listenerId: 'fixture', directMessages: true, deliveryJournal, sendTarget: async (channelId) => { assert.equal(channelId, textChannelId); return target; } });
  const result = await send.channelMessages([
    { channelId: textChannelId, content: `<@${userId}> good job! <@&600000000000000001> @everyone`, notify: true },
    { channelId: textChannelId, content: `nice one <@${userId}>`, notify: false },
  ], trigger);
  assert.equal(result.sentMessages.length, 2);
  assert.ok(posts.every((post) => post.channel === textChannelId));
  assert.deepEqual(posts[0].payload.allowed_mentions, { parse: [], users: [userId] });
  assert.deepEqual(posts[1].payload.allowed_mentions, { parse: [] });
  assert.deepEqual(posts.map((post) => post.payload.nonce), [`${result.batchId}:x0`, `${result.batchId}:x1`]);
  assert.ok(journal.every((entry) => entry.metadata.channelId === dmId && entry.metadata.triggerMessageId === trigger.id));
  assert.equal(result.sentMessages[0].message.url, `https://discord.com/channels/${guildId}/${textChannelId}/700000000000000001`);
});

function engineFixture(channelMessages) {
  const confirmations = [];
  const sendReplies = async (messages) => ({ sentMessages: messages });
  sendReplies.confirmation = async (content) => { confirmations.push(content); return { sentMessages: [content] }; };
  const engine = createProactiveEngine({
    botUserId, channelId: dmId, directMessages: true, batchWindowMs: 5, cooldownMs: 0,
    resolveReplyAuthor: async () => botUserId, getContext: async () => ({ recentMessages: [] }),
    generateReply: async () => ({ shouldReply: true, messages: [{ content: 'On it!' }], channelMessages }), sendReplies,
  });
  return { engine, sendReplies, confirmations };
}

test('the engine confirms posts in the DM, and reports a failed post instead of hiding it', async () => {
  const message = { id: '300000000000000009', channel_id: dmId, author: { id: directMessageOwnerId, bot: false }, content: 'tell Hand good job in av slop chat', mentions: [] };
  const okay = engineFixture([{ channelId: textChannelId, content: 'good job!', notify: true }]);
  okay.sendReplies.channelMessages = async () => ({ sentMessages: [{ message: { channelId: textChannelId, url: 'https://discord.com/channels/1/2/3' } }] });
  try {
    await okay.engine.receive(message);
    for (let attempt = 0; attempt < 200 && !okay.confirmations.length; attempt += 1) await wait(5);
    assert.deepEqual(okay.confirmations, [`Posted in <#${textChannelId}>: https://discord.com/channels/1/2/3`]);
    assert.equal(okay.engine.status().channelMessages, 1);
  } finally { okay.engine.stop(); }

  const failing = engineFixture([{ channelId: textChannelId, content: 'good job!', notify: false }]);
  failing.sendReplies.channelMessages = async () => { const error = new Error('Missing Permissions'); error.sentMessages = []; error.failedMessageIndex = 0; throw error; };
  try {
    await failing.engine.receive({ ...message, id: '300000000000000010' });
    for (let attempt = 0; attempt < 200 && !failing.confirmations.length; attempt += 1) await wait(5);
    for (let attempt = 0; attempt < 200 && failing.engine.status().errors < 1; attempt += 1) await wait(5);
    assert.deepEqual(failing.confirmations, [`I couldn’t post in <#${textChannelId}>: Missing Permissions`]);
    assert.equal(failing.engine.status().errors, 1);
  } finally { failing.engine.stop(); }
});

test('the real delivery journal records cross-channel post receipts and survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-cross-channel-'));
  try {
    const journal = await createDeliveryJournal({ accountId: 'reader', channelId: dmId, root });
    const target = { account: { id: 'reader', client: { sendMessage: async (channel) => ({ id: '700000000000000001', channel_id: channel, content: 'good job' }) } }, channel: { id: textChannelId, guild_id: guildId } };
    const send = createReplySender({}, { channelId: dmId, listenerId: 'fixture', directMessages: true, deliveryJournal: journal, sendTarget: async () => target });
    const trigger = { id: '300000000000000001' };
    const result = await send.channelMessages([{ channelId: textChannelId, content: 'good job', notify: false }], trigger);
    assert.equal(result.sentMessages[0].message.channelId, textChannelId);
    const [entry] = (await journal.entries()).filter((item) => item.operationId.endsWith(':channel:0'));
    assert.equal(entry.status, 'sent');
    assert.equal(entry.channelId, dmId);
    assert.deepEqual(entry.receipt.message, { id: '700000000000000001', channelId: textChannelId, guildId, url: `https://discord.com/channels/${guildId}/${textChannelId}/700000000000000001` });
    await assert.rejects(() => journal.record('plain:0', { accountId: 'reader', message: { id: '700000000000000002', channelId: textChannelId } }), /different channel/, 'unmarked receipts for other channels are still rejected');
    let posts = 0;
    target.account.client.sendMessage = async () => { posts += 1; return { id: '700000000000000009' }; };
    const replay = await send.channelMessages([{ channelId: textChannelId, content: 'good job', notify: false }], trigger);
    assert.equal(posts, 0, 'a repeated plan reuses the journaled receipt instead of reposting');
    assert.equal(replay.sentMessages[0].message.url, result.sentMessages[0].message.url);
    await journal.close();
    const restored = await createDeliveryJournal({ accountId: 'reader', channelId: dmId, root });
    assert.equal((await restored.entries()).find((item) => item.operationId.endsWith(':channel:0')).receipt.crossChannel, true);
    await restored.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
