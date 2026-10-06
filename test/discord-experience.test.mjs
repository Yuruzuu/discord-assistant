import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { splitDiscordText, validateGeneratedFiles } from '../src/proactive/discord-chunks.mjs';
import { createReplySender } from '../src/proactive/reply-sender.mjs';
import { createProgressReporter } from '../src/proactive/progress.mjs';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { validateReplyPlan } from '../src/proactive/reply-validation.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const channelId = '200000000000000001';
const guildId = '200000000000000002';
const trigger = { id: '300000000000000001', channel_id: channelId, guild_id: guildId, author: { id: directMessageOwnerId }, content: 'hello', mentions: [] };

function senderFixture(options = {}) {
  const calls = [];
  let identifier = 400000000000000001n;
  const client = {
    sendMessage: async (_, payload) => { calls.push({ kind: 'send', payload }); return { id: String(identifier++), content: payload.content }; },
    sendMessageFiles: async (_, payload, files) => { calls.push({ kind: 'files', payload, files }); return { id: String(identifier++), attachments: files }; },
    editMessage: async (_, id, payload) => { calls.push({ kind: 'edit', id, payload }); },
    deleteMessage: async (_, id) => { calls.push({ kind: 'delete', id }); },
    addReaction: async (_, id, emoji) => { calls.push({ kind: 'add', id, emoji }); },
    removeOwnReaction: async (_, id, emoji) => { calls.push({ kind: 'remove', id, emoji }); },
  };
  const send = createReplySender({ resolveChannel: async () => ({ account: { id: 'default', client }, channel: { id: channelId } }) }, { channelId, guildId, listenerId: 'fixture', ...options });
  return { send, calls, client };
}

async function until(check) {
  for (let count = 0; count < 100 && !check(); count += 1) await wait(5);
  assert.ok(check(), 'Expected async state');
}

test('long fenced text splits into valid chunks without breaking surrogate pairs or losing content', () => {
  const source = '```luau\n' + 'print("hello 😀")\n'.repeat(400) + '```\nfinished';
  const chunks = splitDiscordText(source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
  assert.ok(chunks.every((chunk) => (chunk.match(/```/g) || []).length === 2));
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
  const restored = chunks.map((chunk, index) => chunk.replace(index ? /^```luau\n/ : /$^/, '').replace(index < chunks.length - 1 ? /\n```$/ : /$^/, '')).join('');
  assert.equal(restored, source);
  assert.throws(() => splitDiscordText('x'.repeat(16001)), /Invalid/);
});

test('generated files permit bounded text only and never accept paths, duplicate names or excessive bytes', () => {
  assert.deepEqual(validateGeneratedFiles([{ name: 'Hotbar.luau', content: 'return {}' }]), [{ name: 'Hotbar.luau', content: 'return {}' }]);
  for (const name of ['../secret.txt', '/secret.txt', 'evil.exe', 'bad..md']) assert.throws(() => validateGeneratedFiles([{ name, content: 'x' }]), /file name/);
  assert.throws(() => validateGeneratedFiles([{ name: 'a.md', content: '😀'.repeat(40000) }]), /limit/);
  assert.throws(() => validateGeneratedFiles([{ name: 'a.md', content: 'a' }, { name: 'a.md', content: 'b' }]), /file name/);
});

test('large reply bubbles preserve first native reference, deterministic chunk nonces and bounded generated attachments', async () => {
  const { send, calls } = senderFixture();
  await send([{ content: '```js\n' + 'a();\n'.repeat(1000) + '```' }], trigger, undefined, { replyToMessageId: trigger.id });
  const text = calls.filter((call) => call.kind === 'send');
  assert.ok(text.length > 1);
  assert.equal(text[0].payload.message_reference.message_id, trigger.id);
  assert.ok(text.slice(1).every((call) => !call.payload.message_reference));
  assert.equal(new Set(text.map((call) => call.payload.nonce)).size, text.length);
  await send.files([{ name: 'research.md', content: 'Useful evidence' }], trigger);
  assert.equal(calls.at(-1).kind, 'files');
  assert.deepEqual(calls.at(-1).files, [{ name: 'research.md', content: 'Useful evidence' }]);
  const dm = senderFixture({ directMessages: true });
  await dm.send.files([{ name: 'notes.txt', content: 'Notes' }], trigger, undefined, { replyToMessageId: trigger.id });
  assert.equal(dm.calls.at(-1).payload.message_reference, undefined);
});

test('known delivery receipts are reused and unknown outcomes block blind reposts', async () => {
  const receipts = new Map();
  const journal = { lookup: async (id) => receipts.get(id), record: async (id, receipt) => receipts.set(id, { status: 'sent', receipt }), unknown: async (id, meta) => receipts.set(id, { status: 'unknown', ...meta }) };
  const { send, calls, client } = senderFixture({ deliveryJournal: journal });
  await send([{ content: 'once' }], trigger);
  await send([{ content: 'once' }], trigger);
  assert.equal(calls.length, 1);
  client.sendMessage = async () => { throw new TypeError('fetch failed'); };
  const next = { ...trigger, id: '300000000000000002' };
  await assert.rejects(send([{ content: 'uncertain' }], next));
  await assert.rejects(send([{ content: 'uncertain' }], next), /unknown/);
});

test('editable progress keeps one message and exports factual bounded details without model text', async () => {
  const { send, calls } = senderFixture();
  let timestamp = 0;
  const progress = createProgressReporter({ send: (text, signal) => send.progress(text, trigger, signal), edit: send.progress.edit, remove: send.progress.remove, now: () => timestamp });
  await progress.receive({ stage: 'started', toolName: 'discord_search_messages', summary: 'secret reasoning' });
  timestamp = 1600;
  await progress.receive({ stage: 'started', toolName: 'discord_message_context' });
  timestamp = 4100;
  await progress.receive({ stage: 'completed', toolName: 'discord_message_context', resultCount: 7, result: 'private content' });
  assert.equal(calls.filter((call) => call.kind === 'send').length, 1);
  assert.equal(calls.filter((call) => call.kind === 'edit').length, 2);
  assert.equal(calls.at(-1).payload.content, 'I’m currently searching the server for messages.\n```\ndiscord_search_messages({})\n```\nI’ve read *7* messages around it.', 'earlier active steps retain their trace while completed traces disappear');
  assert.ok(!JSON.stringify(progress.details()).includes('private'));
  assert.deepEqual(progress.details().at(-1), { toolName: 'discord_message_context', stage: 'completed', elapsedMs: 2500, resultCount: 7 });
  await progress.finish();
  assert.equal(calls.at(-1).kind, 'edit', 'the log is condensed, not deleted');
  assert.equal(calls.at(-1).payload.content, 'I read the conversation around a message.');
  assert.ok(!calls.at(-1).payload.content.includes('```'), 'finishing removes every temporary command trace');
  assert.deepEqual(calls.at(-1).payload.components, [], 'buttons are removed once the answer is done');
});

test('temporary status reactions do not remove natural bot reactions', async () => {
  const { send, calls } = senderFixture();
  await Promise.all([send.statusReaction('queued', trigger), send.statusReaction('working', trigger)]);
  assert.deepEqual(calls.map((call) => [call.kind, call.emoji]), [['add', '⏳'], ['remove', '⏳'], ['add', '⚙️']]);
  await send.react({ messageId: trigger.id, emoji: '⚙️' }, trigger);
  await send.clearStatusReactions();
  assert.ok(!calls.some((call) => call.kind === 'remove' && call.emoji === '⚙️'));
  await send.statusReaction('done', { ...trigger, reactions: [{ me: true, emoji: { name: '✅' } }] });
  await send.clearStatusReactions();
  assert.ok(!calls.some((call) => call.emoji === '✅'));
});

test('file-only plans and streamed text followed by files are delivered once', async () => {
  assert.deepEqual(validateReplyPlan({ shouldReply: true, messages: [], files: [{ name: 'notes.md', content: 'Evidence' }] }, {}), { shouldReply: true, messages: [], files: [{ name: 'notes.md', content: 'Evidence' }] });
  for (const streamed of [false, true]) {
    const { send, calls } = senderFixture();
    const messages = streamed ? [{ content: 'Summary', gifUrl: null, stickerIds: [] }] : [];
    const engine = createProactiveEngine({ channelId, guildId, directMessages: false, mode: 'all', batchWindowMs: 0, cooldownMs: 0, getContext: async () => ({}), generateReply: async (_, signal, callbacks) => {
      if (streamed) await callbacks.onMessage(messages[0], 0, signal);
      return { shouldReply: true, messages, files: [{ name: 'notes.md', content: 'Evidence' }] };
    }, sendReplies: send });
    await engine.receive(trigger);
    await until(() => engine.status().replyBatches === 1);
    engine.stop();
    assert.equal(calls.filter((call) => call.kind === 'send').length, streamed ? 1 : 0);
    assert.equal(calls.filter((call) => call.kind === 'files').length, 1);
  }
});

test('owner controls cancel a single answer without stopping listening, pause rejects chat and corrections steer an active turn', async () => {
  let generations = 0;
  const corrections = [];
  const generateReply = async (_, signal) => { generations += 1; await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); };
  generateReply.steer = async (text) => { corrections.push(text); return { accepted: true }; };
  generateReply.interrupt = async () => {};
  const engine = createProactiveEngine({ channelId, guildId, mode: 'all', batchWindowMs: 0, cooldownMs: 0, getContext: async () => ({}), generateReply, sendReplies: async () => ({ sentMessages: [] }) });
  await assert.rejects(engine.control({ action: 'pause', userId: 'intruder' }), /Only the owner/);
  await engine.receive(trigger);
  await until(() => generations === 1);
  await engine.control({ action: 'steer', value: 'only Shinsoku', userId: directMessageOwnerId });
  assert.deepEqual(corrections, ['only Shinsoku']);
  await engine.control({ action: 'stop', userId: directMessageOwnerId });
  await until(() => !engine.status().generating);
  assert.equal(engine.status().errors, 0);
  await engine.control({ action: 'pause', userId: directMessageOwnerId });
  assert.equal(await engine.receive({ ...trigger, id: '300000000000000005' }), false);
  await engine.control({ action: 'resume', userId: directMessageOwnerId });
  await engine.receive({ ...trigger, id: '300000000000000006' });
  await until(() => generations === 2);
  engine.stop();
});

test('a slow temporary status on another emoji cannot hold an authorized reaction or final reply', async () => {
  const { send, client, calls } = senderFixture({ statusTimeoutMs: 25 });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  client.addReaction = async (_, id, emoji) => { calls.push({ kind: 'add', id, emoji }); if (emoji === '⏳') await blocked; };
  const status = send.statusReaction('queued', trigger);
  await until(() => calls.some((call) => call.emoji === '⏳'));
  await send.react({ messageId: trigger.id, emoji: '👍' }, trigger);
  await send([{ content: 'ready' }], trigger);
  assert.ok(calls.some((call) => call.emoji === '👍'));
  assert.ok(calls.some((call) => call.kind === 'send'));
  await status;
  const newer = { ...trigger, id: '300000000000000002' };
  await send.statusReaction('working', newer);
  assert.ok(calls.some((call) => call.id === newer.id && call.emoji === '⚙️'), 'quarantine affects only the old message');
  release();
  await send.clearStatusReactions();
  assert.ok(!calls.some((call) => call.kind === 'remove' && call.emoji === '👍'));
});

test('a natural reaction waits for its exact in-flight status deletion then owns that emoji', async () => {
  const { send, client, calls } = senderFixture({ statusTimeoutMs: 100 });
  await send.statusReaction('working', trigger);
  let release;
  let deleting = false;
  const blocked = new Promise((resolve) => { release = resolve; });
  client.removeOwnReaction = async (_, id, emoji) => { deleting = true; await blocked; calls.push({ kind: 'remove', id, emoji }); };
  const status = send.statusReaction('done', trigger);
  await until(() => deleting);
  const natural = send.react({ messageId: trigger.id, emoji: '⚙️' }, trigger);
  await wait(5);
  assert.equal(calls.filter((call) => call.kind === 'add' && call.emoji === '⚙️').length, 1, 'never add before the old deletion settles');
  release();
  await Promise.all([status, natural]);
  await send.clearStatusReactions();
  const lastOwnMutation = calls.filter((call) => call.emoji === '⚙️').at(-1);
  assert.equal(lastOwnMutation.kind, 'add', 'late cleanup cannot remove the natural reaction');
});

test('unsettled deletion surfaces a bounded natural-reaction failure instead of racing a late delete', async () => {
  const { send, client, calls } = senderFixture({ statusTimeoutMs: 15 });
  await send.statusReaction('working', trigger);
  let release;
  let deleting = false;
  const blocked = new Promise((resolve) => { release = resolve; });
  client.removeOwnReaction = async () => { deleting = true; await blocked; };
  const status = send.statusReaction('done', trigger);
  await until(() => deleting);
  await assert.rejects(send.react({ messageId: trigger.id, emoji: '⚙️' }, trigger), /outcome is unsettled/);
  assert.equal(calls.filter((call) => call.kind === 'add' && call.emoji === '⚙️').length, 1);
  release();
  await status;
});
