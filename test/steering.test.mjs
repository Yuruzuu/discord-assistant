import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { createProgressReporter } from '../src/proactive/progress.mjs';
import { createConversationReply } from '../src/proactive/conversation.mjs';
import { parseNovaCommand } from '../src/proactive/controls.mjs';
import { createReplyValidator } from '../src/proactive/reply-validation.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const botUserId = '300000000000000001';
let nextMessage = 410000000000000001n;
const message = (properties = {}) => ({ id: String(nextMessage++), guild_id: guildId, channel_id: channelId, author: { id: directMessageOwnerId, bot: false }, content: `<@${botUserId}> hello`, mentions: [{ id: botUserId }], ...properties });

async function until(condition) {
  for (let attempt = 0; attempt < 300 && !condition(); attempt += 1) await wait(5);
  assert.ok(condition(), 'Expected state did not arrive');
}

// One generation hangs until released, so follow-ups arrive while an answer is being written.
function fixture(options = {}) {
  const generations = [];
  const steers = [];
  const completed = [];
  const releases = [];
  let interrupts = 0;
  const generateReply = async (context, signal) => {
    generations.push({ ...context, triggerMessages: context.triggerMessages });
    await new Promise((resolve, reject) => { releases.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    return { shouldReply: true, messages: [{ content: 'done' }] };
  };
  generateReply.steer = options.steer || (async (text) => { steers.push(JSON.parse(text)); return { accepted: true }; });
  generateReply.interrupt = async () => { interrupts += 1; };
  const engine = createProactiveEngine({
    botUserId, guildId, channelId, batchWindowMs: 5, cooldownMs: 0, maxRepliesPerMinute: 60,
    resolveReplyAuthor: async () => botUserId, getContext: async () => ({ recentMessages: [] }), generateReply,
    sendReplies: async (messages) => ({ sentMessages: messages }),
    onBatchComplete: (messages, outcome) => { completed.push(...messages.map((item) => [item.id, outcome])); },
    ...options.engine,
  });
  return { engine, generations, steers, completed, release: () => releases.shift()?.(), interrupts: () => interrupts };
}

test('owner follow-ups steer the active answer by default and finish with it', async () => {
  const { engine, generations, steers, completed, release } = fixture();
  try {
    const first = message();
    await engine.receive(first);
    await until(() => generations.length === 1);
    const followUp = message({ content: `<@${botUserId}> actually only the mobile ones` });
    await engine.receive(followUp);
    await until(() => steers.length === 1);
    assert.equal(steers[0].ownerSteering.triggerMessages[0].id, followUp.id);
    assert.match(steers[0].ownerSteering.triggerMessages[0].content, /mobile/);
    assert.deepEqual(generations[0].triggerMessages.map((item) => item.id), [first.id, followUp.id], 'steered messages join the turn for reactions and context bookkeeping');
    assert.equal(engine.status().steered, 1);
    release();
    await until(() => completed.length === 2);
    assert.deepEqual(completed, [[first.id, 'sent'], [followUp.id, 'sent']]);
    assert.equal(generations.length, 1, 'no second turn for a steered follow-up');
  } finally { engine.stop(); }
});

test('attachments, refused steers and followup mode get their own turn; interrupt mode replaces the answer', async () => {
  const media = fixture();
  try {
    await media.engine.receive(message());
    await until(() => media.generations.length === 1);
    await media.engine.receive(message({ attachments: [{ id: '1', url: 'https://cdn.discordapp.com/a.png' }] }));
    await wait(30);
    assert.equal(media.steers.length, 0);
    media.release();
    await until(() => media.generations.length === 2);
    media.release();
  } finally { media.engine.stop(); }

  const refused = fixture({ steer: async () => ({ accepted: false }) });
  try {
    await refused.engine.receive(message());
    await until(() => refused.generations.length === 1);
    await refused.engine.receive(message({ content: 'and this' }));
    await wait(30);
    refused.release();
    await until(() => refused.generations.length === 2);
    refused.release();
  } finally { refused.engine.stop(); }

  const followup = fixture({ engine: { queueMode: 'followup' } });
  try {
    await followup.engine.receive(message());
    await until(() => followup.generations.length === 1);
    await followup.engine.receive(message());
    await wait(30);
    assert.equal(followup.steers.length, 0);
    followup.release();
    await until(() => followup.generations.length === 2);
    followup.release();
  } finally { followup.engine.stop(); }

  const interrupting = fixture();
  try {
    await interrupting.engine.receive(message());
    await until(() => interrupting.generations.length === 1);
    assert.deepEqual(await interrupting.engine.control({ action: 'queue', value: 'interrupt', userId: directMessageOwnerId }), { action: 'queue', queueMode: 'interrupt', paused: false });
    const newest = message({ content: 'never mind, do this instead' });
    await interrupting.engine.receive(newest);
    await until(() => interrupting.generations.length === 2);
    assert.equal(interrupting.interrupts(), 1);
    assert.deepEqual(interrupting.generations[1].triggerMessages.map((item) => item.id), [newest.id]);
    assert.ok(interrupting.completed.some(([, outcome]) => outcome === 'cancelled'));
    interrupting.release();
    await assert.rejects(interrupting.engine.control({ action: 'queue', value: 'collect', userId: directMessageOwnerId }), /Queue mode/);
  } finally { interrupting.engine.stop(); }
});

test('follow-ups join a queued answer that has not started, and a full queue hands summaries of what it drops to the next answer', async () => {
  const { engine, generations, completed, release } = fixture({ engine: { maxQueued: 2, queueMode: 'followup' } });
  try {
    await engine.receive(message());
    await until(() => generations.length === 1);
    // Followup mode neither steers nor merges, so each message waits in the queue.
    const queued = (content) => message({ content });
    await engine.receive(queued('first queued'));
    await wait(20);
    await engine.receive(queued('second queued'));
    await wait(20);
    await engine.receive(queued('third queued'));
    await wait(20);
    assert.equal(engine.status().overflowed, 1);
    assert.ok(completed.some(([, outcome]) => outcome === 'skipped'));
    release();
    await until(() => generations.length === 2);
    assert.deepEqual(generations[1].droppedMessages.map((item) => item.excerpt), ['first queued']);
    release();
    await until(() => generations.length === 3);
    assert.equal(generations[2].droppedMessages, undefined);
    release();
  } finally { engine.stop(); }

  const waiting = fixture({ engine: { scheduleReply: async (operation) => { await wait(60); return operation(); } } });
  try {
    const first = message();
    await waiting.engine.receive(first);
    await wait(20);
    const second = message({ content: 'one more thing' });
    await waiting.engine.receive(second);
    await until(() => waiting.generations.length === 1);
    assert.deepEqual(waiting.generations[0].triggerMessages.map((item) => item.id), [first.id, second.id]);
    assert.equal(waiting.steers.length, 0);
    waiting.release();
  } finally { waiting.engine.stop(); }
});

test('Codex writes a revised answer after a steer; sent bubbles stay and the revision continues after them', async () => {
  const bubble = (content) => ({ content, gifUrl: null, stickerIds: [], embeds: [], buttons: [] });
  const fixtureServer = fakeCodexServer({
    plans: [{ shouldReply: true, messages: [bubble('first take')] }], steeredPlan: { shouldReply: true, messages: [bubble('revised for mobile')] },
    toolCalls: [{ tool: 'lookup' }], events: [{ method: 'item/started', params: { item: { id: 'reasoning-1', type: 'reasoning' } } }],
  });
  let releaseTool;
  const gate = new Promise((resolve) => { releaseTool = resolve; });
  const tools = { definitions: [{ name: 'lookup', description: 'Read context', inputSchema: { type: 'object' } }], has: (name) => name === 'lookup', call: async () => { await gate; return { success: true, contentItems: [] }; }, errorMessage: (error) => error.message };
  const respond = createConversationReply({ spawnImpl: fixtureServer.spawnImpl, readTools: tools });
  const context = { channelId, guildId: null, directMessages: true, recentMessages: [], triggerMessages: [], expressions: { emojis: [], stickers: [] } };
  const streamed = [];
  const progress = [];
  try {
    const pending = respond(context, undefined, { onMessage: async (item, index) => { streamed.push([index, item.content]); }, onProgress: (event) => { progress.push(event); } });
    await until(() => fixtureServer.requests.some((entry) => entry.method === 'turn/start'));
    assert.equal((await respond.steer('{"ownerSteering":{}}')).accepted, true);
    releaseTool();
    const plan = await pending;
    assert.deepEqual(streamed, [[0, 'first take'], [1, 'revised for mobile']]);
    assert.deepEqual(plan.messages.map((item) => item.content), ['first take', 'revised for mobile']);
    assert.ok(progress.some((event) => event.toolName === 'reasoning' && event.stage === 'started'));
  } finally { await respond.close(); }

  const unsteered = fakeCodexServer({ plans: [{ shouldReply: true, messages: [bubble('only answer')] }], steeredPlan: { shouldReply: true, messages: [bubble('never')] } });
  const plain = createConversationReply({ spawnImpl: unsteered.spawnImpl });
  try { assert.deepEqual((await plain(context)).messages.map((item) => item.content), ['only answer']); }
  finally { await plain.close(); }
});

test('the progress log shows a delayed thinking line, collapses past six steps, and quick thinking posts nothing', async () => {
  const sent = [];
  const edits = [];
  let removed = 0;
  const reporter = (options = {}) => createProgressReporter({ intervalMs: 0, thinkingDelayMs: 20,
    send: async (content) => { sent.push(content); return { sentMessages: [{ message: { id: 'progress' } }] }; },
    edit: async (_, content) => { edits.push(content); }, remove: async () => { removed += 1; }, ...options });

  const quick = reporter();
  await quick.receive({ stage: 'started', toolName: 'reasoning' });
  await quick.receive({ stage: 'completed', toolName: 'reasoning' });
  await wait(40);
  await quick.finish();
  assert.deepEqual(sent, []);

  const slow = reporter();
  await slow.receive({ stage: 'started', toolName: 'reasoning' });
  await until(() => sent.length === 1);
  assert.equal(sent[0], '-# 💭 Thinking…');
  await slow.finish();
  assert.equal(removed, 1, 'a log that only ever thought is removed once the answer is done');

  const long = reporter();
  for (let index = 0; index < 9; index += 1) {
    await long.receive({ stage: 'started', toolName: 'web_read_link', callId: `c${index}`, arguments: { url: `https://example${index}.com` } });
    await long.receive({ stage: 'completed', toolName: 'web_read_link', callId: `c${index}`, arguments: { url: `https://example${index}.com` } });
  }
  await long.receive({ stage: 'started', toolName: 'reasoning' });
  await long.idle();
  const latest = edits.at(-1).split('\n');
  assert.equal(latest[0], '-# …and *3* more steps');
  assert.deepEqual(latest.slice(1, -1), [3, 4, 5, 6, 7, 8].map((index) => `-# 🔗 I’ve read example${index}.com.`));
  assert.equal(latest.at(-1), '-# 💭 Thinking…');
  long.close();
});

test('the queue command parses, and steered messages are valid reaction targets', () => {
  assert.deepEqual(parseNovaCommand('nova queue followup', botUserId), { action: 'queue', value: 'followup' });
  const triggerMessages = [{ id: '700000000000000001' }];
  const validator = createReplyValidator({ channelId, triggerMessages, recentMessages: [], expressions: { emojis: [], stickers: [] } });
  triggerMessages.push({ id: '700000000000000002' });
  assert.equal(validator.plan({ shouldReply: false, messages: [], reactions: [{ messageId: '700000000000000002', emoji: '👍' }] }).reactions.length, 1);
});
