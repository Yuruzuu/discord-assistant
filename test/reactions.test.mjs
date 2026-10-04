import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { normalizeReactionEmoji, addReaction } from '../src/reactions.mjs';
import { DiscordApiClient } from '../src/discord-api.mjs';
import { createReplyValidator } from '../src/proactive/reply-validation.mjs';
import { createReplyStream } from '../src/proactive/reply-stream.mjs';
import { createReplySender } from '../src/proactive/reply-sender.mjs';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const messageId = '300000000000000001';
const botUserId = '400000000000000001';
const customEmojiId = '500000000000000001';

test('reactions accept Unicode graphemes, flags, skin tones and custom emojis while rejecting plain text and route injection', () => {
  for (const emoji of ['👍', '👍🏽', '❤️', '🇵🇭', '1️⃣', '👨‍👩‍👧‍👦', '🫠']) assert.equal(normalizeReactionEmoji(emoji), emoji);
  assert.equal(normalizeReactionEmoji(`<:wave:${customEmojiId}>`), `wave:${customEmojiId}`);
  assert.equal(normalizeReactionEmoji(`<a:wave:${customEmojiId}>`), `wave:${customEmojiId}`);
  for (const emoji of ['', 'hi', ':wave:', '👍👍', ' 👍', '👍/../@everyone', 'a', '1', `wave:${customEmojiId}/@me`]) assert.throws(() => normalizeReactionEmoji(emoji), /one Unicode emoji/);
});

test('reaction endpoint encodes emoji, accepts HTTP 204 and retries idempotent PUT without a body', async () => {
  const requests = [];
  const client = new DiscordApiClient({ accountId: 'default', token: 'fixture', sleep: async () => {}, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) throw new TypeError('fetch failed');
    return new Response(null, { status: 204 });
  } });
  const service = { resolveChannel: async () => ({ account: { id: 'default', client }, channel: { id: channelId } }) };
  assert.equal((await addReaction(service, { channelId, messageId, emoji: '👍🏽' })).reacted, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent('👍🏽')}/@me`);
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.body, undefined);
  await addReaction(service, { channelId, messageId, emoji: `<:wave:${customEmojiId}>` });
  assert.ok(requests.at(-1).url.includes(encodeURIComponent(`wave:${customEmojiId}`)));
});

test('cancelled reactions do not resolve or mutate a channel', async () => {
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(() => addReaction({ resolveChannel: () => { throw new Error('Must not resolve'); } }, { channelId, messageId, emoji: '❤️' }, { signal: cancellation.signal }), /abort/i);
});

test('reaction plans allow reaction-only responses and deduplicate targets, without accepting arbitrary messages', () => {
  const validator = createReplyValidator({ channelId, expressions: {}, triggerMessages: [{ id: messageId, channel_id: channelId }], recentMessages: [{ id: '300000000000000002', channelId: '200000000000000002' }] });
  const reaction = { messageId, emoji: '👍' };
  assert.deepEqual(validator.plan({ shouldReply: false, messages: [], reactions: [reaction, reaction] }), { shouldReply: false, messages: [], reactions: [reaction] });
  assert.throws(() => validator.plan({ shouldReply: false, messages: [], reactions: [{ messageId: '300000000000000002', emoji: '👍' }] }), /outside the supplied conversation/);
  assert.throws(() => validator.plan({ shouldReply: false, messages: [], reactions: [{ messageId, emoji: 'text' }] }), /one Unicode emoji/);
  assert.throws(() => validator.plan({ shouldReply: false, messages: [], reactions: Array.from({ length: 4 }, () => reaction) }));
});

test('reaction arrays before or after messages are never streamed as reply bubbles', () => {
  const messages = [{ content: 'nice!', gifUrl: null, stickerIds: [] }];
  const reactions = [{ messageId, emoji: '👨‍👩‍👧‍👦' }];
  for (const plan of [{ shouldReply: true, messages, reactions }, { shouldReply: true, reactions, messages }, { shouldReply: false, messages: [], reactions }]) {
    const delivered = [];
    const stream = createReplyStream((message) => delivered.push(message));
    for (const character of JSON.stringify(plan)) stream.push(character);
    assert.deepEqual(delivered, plan.shouldReply ? messages : []);
  }
});

test('DMs and standalone mentions stay ordinary messages while server chains retain one native reply', async () => {
  for (const directMessages of [false, true]) {
    const payloads = [];
    const client = { sendMessage: async (_, payload) => { payloads.push(payload); return { id: messageId, content: payload.content }; } };
    const sender = createReplySender({ resolveChannel: async () => ({ account: { id: 'default', client }, channel: { id: channelId } }) }, { channelId, directMessages, listenerId: 'fixture' });
    await sender([{ content: 'standalone' }], { id: messageId });
    assert.equal(payloads[0].message_reference, undefined);
    await sender([{ content: 'chain' }, { content: 'extra' }], { id: messageId, message_reference: { message_id: '300000000000000002' } });
    assert.equal(payloads[1].message_reference?.message_id, directMessages ? undefined : messageId);
    assert.equal(payloads[2].message_reference, undefined);
    await sender([{ content: 'batched chain' }], { id: messageId }, undefined, { replyToMessageId: messageId });
    assert.equal(payloads[3].message_reference?.message_id, directMessages ? undefined : messageId);
  }
});

async function until(condition) {
  for (let index = 0; index < 200 && !condition(); index += 1) await setTimeout(5);
  assert.ok(condition());
}

test('automatic reaction-only plans act once; reaction failures preserve written answers', async () => {
  for (const fail of [false, true]) {
    const actions = [];
    const sends = [];
    const sendReplies = async (messages) => { sends.push(...messages); return { sentMessages: messages }; };
    sendReplies.react = async (reaction) => { actions.push(reaction); if (fail) throw new Error('Missing Add Reactions permission'); };
    const engine = createProactiveEngine({ guildId, channelId, botUserId, batchWindowMs: 0, cooldownMs: 0,
      getContext: async () => ({}), sendReplies,
      generateReply: async () => ({ shouldReply: fail, messages: fail ? [{ content: 'still answering' }] : [], reactions: [{ messageId, emoji: '👍' }] }),
    });
    try {
      await engine.receive({ id: messageId, guild_id: guildId, channel_id: channelId, author: { id: directMessageOwnerId }, content: `<@${botUserId}> nice` });
      await until(() => actions.length && !engine.status().generating);
      assert.equal(engine.status().reactions, fail ? 0 : 1);
      assert.equal(engine.status().reactionErrors, fail ? 1 : 0);
      assert.equal(engine.status().errors, 0);
      assert.deepEqual(sends.map((message) => message.content), fail ? ['still answering'] : []);
    } finally { engine.stop(); }
  }
});

test('engine uses native server replies for batches or intervening messages, while DMs remain plain', async () => {
  for (const scenario of ['standalone', 'batch', 'intervening', 'dm']) {
    const options = [];
    const engine = createProactiveEngine({ guildId, channelId, botUserId, directMessages: scenario === 'dm', mode: 'all', batchWindowMs: 5, cooldownMs: 0,
      getContext: async () => ({ recentMessages: scenario === 'intervening' ? [{ id: '300000000000000004', authorId: '600000000000000001' }] : [] }),
      generateReply: async () => ({ shouldReply: true, messages: [{ content: 'answer' }] }),
      sendReplies: async (messages, trigger, signal, metadata) => { options.push(metadata); return { sentMessages: messages }; },
    });
    const incoming = (id) => ({ id, guild_id: scenario === 'dm' ? null : guildId, channel_id: channelId, author: { id: directMessageOwnerId }, content: 'hello' });
    try {
      await engine.receive(incoming(messageId));
      if (scenario === 'batch') await engine.receive(incoming('300000000000000002'));
      await until(() => options.length);
      assert.equal(options[0].replyToMessageId, scenario === 'batch' ? '300000000000000002' : scenario === 'intervening' ? messageId : undefined);
    } finally { engine.stop(); }
  }
});
