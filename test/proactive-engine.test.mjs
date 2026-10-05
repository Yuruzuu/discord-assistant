import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { startTypingIndicator } from '../src/proactive/typing.mjs';
import { parseMemoryCommand } from '../src/proactive/memory.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const botUserId = '300000000000000001';
let nextMessage = 400000000000000001n;

function message(properties = {}) {
  return { id: String(nextMessage++), guild_id: guildId, channel_id: channelId, author: { id: directMessageOwnerId, bot: false }, content: 'hello', mentions: [], ...properties };
}

function fixture(options = {}) {
  const generations = [];
  const sends = [];
  let referenceChecks = 0;
  const engine = createProactiveEngine({
    botUserId, guildId, channelId, batchWindowMs: 5, cooldownMs: 0,
    resolveReplyAuthor: async () => { referenceChecks += 1; return botUserId; },
    getContext: async () => ({ recentMessages: [] }),
    generateReply: async (context) => { generations.push(context); return { shouldReply: true, messages: [{ content: 'hey!' }] }; },
    sendReplies: async (messages, trigger) => { sends.push({ messages, trigger }); return { sentMessages: messages }; },
    ...options,
  });

  return { engine, generations, sends, referenceChecks: () => referenceChecks };
}

async function until(condition) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await setTimeout(5);
  assert.ok(condition(), 'Expected engine state did not arrive');
}

test('mentions trigger a reply, while other channels and bot messages are ignored', async () => {
  const { engine, sends, referenceChecks } = fixture();
  try {
    assert.equal(await engine.receive(message({ channel_id: '200000000000000002', content: `<@${botUserId}> hey` })), false);
    assert.equal(await engine.receive(message({ author: { id: botUserId, bot: true }, content: `<@${botUserId}>` })), false);
    assert.equal(await engine.receive(message({ content: 'normal chatter' })), false);
    assert.equal(await engine.receive(message({ content: `<@${botUserId}> how are you?` })), true);
    await until(() => sends.length === 1);
    assert.equal(referenceChecks(), 0);
  } finally { engine.stop(); }
});

test('native replies to the bot trigger responses without a new mention', async () => {
  const { engine, sends, referenceChecks } = fixture();
  try {
    await engine.receive(message({ message_reference: { message_id: '600000000000000001' } }));
    await until(() => sends.length === 1);
    assert.equal(referenceChecks(), 1);
  } finally { engine.stop(); }
});

test('human message bubbles are batched and the latest message is the reply target', async () => {
  const { engine, generations, sends } = fixture({ batchWindowMs: 20 });
  try {
    const first = message({ content: `<@${botUserId}> I have a question` });
    const second = message({ content: 'how does this work?' });
    await engine.receive(first);
    await engine.receive(second);
    await until(() => sends.length === 1);
    assert.deepEqual(generations[0].triggerMessages.map((message) => message.id), [first.id, second.id]);
    assert.equal(sends[0].trigger.id, second.id);
  } finally { engine.stop(); }
});

test('replayed Gateway messages are not answered twice', async () => {
  const { engine, sends } = fixture();
  try {
    const incoming = message({ mentions: [{ id: botUserId }] });
    await engine.receive(incoming);
    await until(() => sends.length === 1);
    assert.equal(await engine.receive(incoming), false);
    await setTimeout(10);
    assert.equal(sends.length, 1);
  } finally { engine.stop(); }
});

test('questions and all-message modes use their selected trigger policy', async () => {
  for (const mode of ['questions', 'all']) {
    const { engine, sends } = fixture({ mode });
    try {
      if (mode === 'questions') assert.equal(await engine.receive(message({ content: 'just chatting' })), false);
      await engine.receive(message({ content: mode === 'questions' ? 'Can you explain this?' : 'just chatting' }));
      await until(() => sends.length === 1);
    } finally { engine.stop(); }
  }
});

test('stopping clears pending batches before they generate a reply', async () => {
  const { engine, generations, sends } = fixture({ batchWindowMs: 20 });
  await engine.receive(message({ mentions: [{ id: botUserId }] }));
  engine.stop();
  await setTimeout(30);
  assert.equal(generations.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(engine.status().queued, 0);
});

test('stopping cancels an active generation and prevents sending', async () => {
  let started = false;
  const { engine, sends } = fixture({
    generateReply: (_, signal) => new Promise((resolve, reject) => {
      started = true;
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    }),
  });
  await engine.receive(message({ mentions: [{ id: botUserId }] }));
  await until(() => started);
  engine.stop();
  await until(() => !engine.status().generating);
  assert.equal(sends.length, 0);
});

test('generation failures release the queue and obey cooldown before another attempt', async () => {
  let current = 0;
  let calls = 0;
  const waits = [];
  const { engine, sends } = fixture({
    cooldownMs: 100,
    now: () => current,
    sleep: async (delay) => { waits.push(delay); current += delay; },
    generateReply: async () => {
      if (++calls === 1) throw new Error('Provider unavailable');
      return { shouldReply: true, messages: [{ content: 'back!' }] };
    },
  });
  try {
    await engine.receive(message({ mentions: [{ id: botUserId }] }));
    await until(() => engine.status().errors === 1);
    await engine.receive(message({ mentions: [{ id: botUserId }] }));
    await until(() => sends.length === 1);
    assert.deepEqual(waits, [100]);
  } finally { engine.stop(); }
});

test('typing covers context lookup, generation and sending, while idle messages do not trigger it', async () => {
  const events = [];
  let typing = false;
  const { engine } = fixture({
    startTyping: () => { typing = true; events.push('typing'); return () => { typing = false; events.push('stopped'); }; },
    getContext: async () => { assert.equal(typing, true); events.push('context'); return {}; },
    generateReply: async () => { assert.equal(typing, true); events.push('generate'); return { shouldReply: true, messages: [{ content: 'hello' }] }; },
    sendReplies: async (messages) => { await setTimeout(10); assert.equal(typing, true); events.push('send'); return { sentMessages: messages }; },
  });
  try {
    await engine.receive(message({ content: 'ordinary chatter' }));
    await setTimeout(10);
    assert.deepEqual(events, []);
    await engine.receive(message({ mentions: [{ id: botUserId }] }));
    await until(() => events.includes('stopped'));
    assert.deepEqual(events, ['typing', 'context', 'generate', 'send', 'stopped']);
  } finally { engine.stop(); }
});

test('declining a reply or failing generation releases the typing indicator', async () => {
  for (const outcome of ['skip', 'error']) {
    let started = 0;
    let stopped = 0;
    const { engine, sends } = fixture({
      startTyping: () => { started += 1; return () => { stopped += 1; }; },
      generateReply: async () => { if (outcome === 'error') throw new Error('Provider unavailable'); return { shouldReply: false, messages: [] }; },
    });
    try {
      await engine.receive(message({ mentions: [{ id: botUserId }] }));
      await until(() => stopped === 1);
      assert.equal(started, 1);
      assert.equal(sends.length, 0);
    } finally { engine.stop(); }
  }
});

test('listener cancellation immediately stops typing renewal during an active generation', async () => {
  let pulses = 0;
  const { engine } = fixture({
    startTyping: (signal) => startTypingIndicator(async () => { pulses += 1; }, { signal, intervalMs: 5 }),
    generateReply: (_, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    }),
  });
  try {
    await engine.receive(message({ mentions: [{ id: botUserId }] }));
    await until(() => pulses >= 2);
    engine.stop();
    const completed = pulses;
    await setTimeout(20);
    assert.equal(pulses, completed);
    await until(() => !engine.status().generating);
  } finally { engine.stop(); }
});

test('streamed bubbles arrive before generation completes and are not sent again at completion', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const messages = [{ content: 'First' }, { content: 'Second' }];
  const offsets = [];
  const sent = [];
  const { engine } = fixture({
    generateReply: async (_, signal, { onMessage }) => {
      await onMessage(messages[0], 0);
      await gate;
      await onMessage(messages[1], 1);
      return { shouldReply: true, messages };
    },
    sendReplies: async (messages, trigger, signal, { offset }) => { offsets.push(offset); sent.push(...messages); return { sentMessages: messages }; },
  });
  try {
    await engine.receive(message({ mentions: [{ id: botUserId }] }));
    await until(() => sent.length === 1);
    assert.equal(engine.status().generating, true);
    release();
    await until(() => !engine.status().generating);
    assert.deepEqual(sent, messages);
    assert.deepEqual(offsets, [0, 1]);
    assert.equal(engine.status().sentMessages, 2);
    assert.equal(engine.status().streamedMessages, 2);
  } finally { release(); engine.stop(); }
});

test('generation failure after streaming preserves partial receipts and stops the remaining reply', async () => {
  const { engine, sends } = fixture({ generateReply: async (_, signal, { onMessage }) => {
    await onMessage({ content: 'First' }, 0);
    throw new Error('Connection lost');
  } });
  try {
    await engine.receive(message({ mentions: [{ id: botUserId }] }));
    await until(() => engine.status().errors === 1);
    assert.equal(sends.length, 1);
    assert.equal(engine.status().sentMessages, 1);
  } finally { engine.stop(); }
});

test('owner memory commands bypass the model and keep adjacent chat out of the saved command batch', async () => {
  const commands = [];
  const { engine, generations, sends } = fixture({ batchWindowMs: 10,
    parseCommand: (message) => parseMemoryCommand(message, botUserId),
    handleCommands: async (messages) => { commands.push(...messages); return { shouldReply: true, messages: [{ content: 'Saved' }] }; },
  });
  try {
    const owner = { id: directMessageOwnerId, bot: false };
    await engine.receive(message({ author: owner, content: `<@${botUserId}> remember this: approved fact` }));
    await until(() => sends.length === 1);
    assert.equal(generations.length, 0);
    assert.equal(commands.length, 1);
    await engine.receive(message({ author: owner, content: `<@${botUserId}> normal chat` }));
    await until(() => generations.length === 1);
    assert.equal(commands.length, 1);
  } finally { engine.stop(); }
});

test('real tool progress precedes final replies without consuming final bubble offsets or response counters', async () => {
  const activity = [];
  const finals = [];
  const sendReplies = async (messages, trigger, signal, { offset }) => {
    finals.push({ messages, trigger, offset });
    return { sentMessages: messages };
  };
  sendReplies.progress = async (content, trigger, signal, { index }) => {
    activity.push({ content, trigger, index });
    return { sentMessages: [content] };
  };
  const { engine } = fixture({ sendReplies, generateReply: async (_, signal, { onProgress, onMessage }) => {
    await onProgress({ stage: 'started', toolName: 'discord_search_messages' }, signal);
    assert.equal(activity.length, 1);
    await onMessage({ content: 'Found the discussion' }, 0);
    await onProgress({ stage: 'failed', toolName: 'discord_message_context' }, signal);
    return { shouldReply: true, messages: [{ content: 'Found the discussion' }, { content: 'Here is the rest' }] };
  } });
  try {
    const incoming = message({ mentions: [{ id: botUserId }] });
    await engine.receive(incoming);
    await until(() => !engine.status().generating && finals.length === 2);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].trigger.id, incoming.id);
    assert.equal(activity[0].index, 0);
    assert.deepEqual(finals.map((sent) => sent.offset), [0, 1]);
    assert.equal(engine.status().progressMessages, 1);
    assert.equal(engine.status().sentMessages, 2);
    assert.equal(engine.status().streamedMessages, 1);
    assert.ok(engine.status().lastFirstActivityMs !== null);
    assert.ok(engine.status().lastFirstResponseMs !== null);
  } finally { engine.stop(); }
});

test('failed activity delivery leaves the generated final answer intact', async () => {
  const sendReplies = async (messages) => ({ sentMessages: messages });
  sendReplies.progress = async () => { throw new Error('Activity send rejected'); };
  const { engine } = fixture({ sendReplies, generateReply: async (_, signal, { onProgress }) => {
    await onProgress({ stage: 'started', toolName: 'discord_search_messages' }, signal);
    return { shouldReply: true, messages: [{ content: 'Here is the answer' }] };
  } });
  try {
    await engine.receive(message({ mentions: [{ id: botUserId }] }));
    await until(() => engine.status().replyBatches === 1);
    assert.equal(engine.status().progressMessages, 0);
    assert.equal(engine.status().progressErrors, 1);
    assert.equal(engine.status().errors, 0);
    assert.equal(engine.status().sentMessages, 1);
  } finally { engine.stop(); }
});

test('a full reply plan delivers in order and counts each confirmed message once', async () => {
  const events = [];
  const replies = [];
  const record = (event, sentMessages) => { events.push(event); return { sentMessages }; };
  const sendReplies = async (messages, trigger, signal, options) => { replies.push(['bubbles', options.replyToMessageId]); return record(`bubbles:${messages.length}`, messages); };
  sendReplies.react = async (reaction) => { events.push(`react:${reaction.emoji}`); };
  sendReplies.files = async (files, trigger, signal, options) => { replies.push(['files', options.replyToMessageId]); return record(`files:${files.length}`, [{}]); };
  sendReplies.images = async (handles) => record(`images:${handles.length}`, [{}]);
  sendReplies.channelMessages = async (items) => record(`posts:${items.length}`, items.map((item, index) => ({ message: { channelId: item.channelId, url: `https://discord.com/channels/1/2/${index}` } })));
  sendReplies.confirmation = async (content) => record(`confirmation:${content.split('\n').length}`, [content]);
  sendReplies.forwards = async (forwards) => record(`forwards:${forwards.length}`, forwards);
  sendReplies.controls = async () => { events.push('controls'); return true; };
  const reference = { message_reference: { message_id: '600000000000000001' }, mentions: [{ id: botUserId }] };
  const full = { shouldReply: true, messages: [{ content: 'one' }, { content: 'two' }], reactions: [{ messageId: '400000000000000001', emoji: '👍' }], files: [{ name: 'notes.md', content: 'notes' }], images: ['img1'],
    channelMessages: [{ channelId, content: 'hi', notify: false }, { channelId, content: 'again', notify: false }], forwards: [{ channelId, messageId: '400000000000000002' }], controls: true };
  const { engine } = fixture({ sendReplies, generateReply: async () => full });
  try {
    const incoming = message(reference);
    await engine.receive(incoming);
    await until(() => engine.status().replyBatches === 1);
    assert.deepEqual(events, ['react:👍', 'bubbles:2', 'files:1', 'images:1', 'posts:2', 'confirmation:2', 'forwards:1', 'controls']);
    assert.deepEqual(replies, [['bubbles', incoming.id], ['files', undefined]], 'files reply natively only when no bubble went out');
    const { sentMessages, streamedMessages, reactions, channelMessages, forwards, errors } = engine.status();
    assert.deepEqual({ sentMessages, streamedMessages, reactions, channelMessages, forwards, errors }, { sentMessages: 6, streamedMessages: 0, reactions: 1, channelMessages: 2, forwards: 1, errors: 0 });
  } finally { engine.stop(); }

  replies.length = 0;
  const filesOnly = fixture({ sendReplies, generateReply: async () => ({ shouldReply: true, messages: [], files: full.files }) });
  try {
    const incoming = message(reference);
    await filesOnly.engine.receive(incoming);
    await until(() => filesOnly.engine.status().replyBatches === 1);
    assert.deepEqual(replies, [['files', incoming.id]]);
    assert.equal(filesOnly.engine.status().sentMessages, 1);
  } finally { filesOnly.engine.stop(); }
});
