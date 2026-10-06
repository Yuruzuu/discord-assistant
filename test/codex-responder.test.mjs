import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { stat } from 'node:fs/promises';
import { createReplyValidator } from '../src/proactive/reply-validation.mjs';
import { createCodexResponder, responderEnvironment, validateReplyPlan } from '../src/proactive/codex-responder.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

const context = {
  channelId: '200000000000000001', guildId: null, directMessages: true,
  expressions: { emojis: [{ markup: '<:wave:300000000000000001>' }], stickers: [{ id: '400000000000000001', available: true }] },
  allowedGifUrls: ['https://media.tenor.com/example/hello.gif'], recentMessages: [], triggerMessages: [],
};

test('Codex workers exclude Discord tokens and unrelated credentials', () => {
  assert.deepEqual(responderEnvironment({ HOME: '/home/test', PATH: '/bin', DISCORD_TOKEN: 'secret', TOKEN_SECONDARY: 'secret', OPENAI_API_KEY: 'secret' }), { HOME: '/home/test', PATH: '/bin' });
});

test('reply plans reject invented server expressions and GIFs', () => {
  const plan = { shouldReply: true, messages: [{ content: 'hello <:wave:300000000000000001>', stickerIds: [], gifUrl: null }] };
  assert.equal(validateReplyPlan(plan, context).messages.length, 1);
  assert.throws(() => validateReplyPlan({ ...plan, messages: [{ content: '<:invented:300000000000000009>', stickerIds: [], gifUrl: null }] }, context), /unavailable custom emoji/);
  assert.throws(() => validateReplyPlan({ ...plan, messages: [{ content: 'hello', stickerIds: ['400000000000000009'], gifUrl: null }] }, context), /unavailable server sticker/);
  assert.throws(() => validateReplyPlan({ ...plan, messages: [{ content: 'hello', stickerIds: [], gifUrl: 'https://example.com/unknown.gif' }] }, context), /outside the supplied catalog/);
});

test('one worker and ephemeral thread serve multiple turns and retain cache usage', async () => {
  const server = fakeCodexServer();
  const respond = createCodexResponder({ command: 'fixture-codex', spawnImpl: server.spawnImpl });
  try {
    await respond.warmup();
    const threadId = respond.status().threadId;
    await respond({ ...context, recentMessages: [{ id: '500000000000000001', content: 'first' }] });
    await respond({ ...context, recentMessages: [{ id: '500000000000000001', content: 'first' }, { id: '500000000000000002', content: 'second' }] });
    assert.equal(server.launches.length, 1);
    assert.equal(server.requests.filter((request) => request.method === 'thread/start').length, 1);
    const turns = server.requests.filter((request) => request.method === 'turn/start');
    assert.ok(turns.every((request) => request.params.threadId === threadId));
    assert.deepEqual(JSON.parse(turns[1].params.input[0].text).recentMessages.map((message) => message.id), ['500000000000000002']);
    assert.equal(respond.status().cachedInputTokens, 1024);
    assert.equal(respond.status().turns, 2);
    const start = server.requests.find((request) => request.method === 'thread/start').params;
    assert.equal(start.ephemeral, true);
    assert.equal(start.model, 'gpt-6.1-sol');
    assert.equal(start.serviceTier, 'priority');
    assert.equal(start.config.model_reasoning_effort, 'low');
    assert.deepEqual(start.config.mcp_servers, { discord: { enabled: false } });
    assert.ok(!JSON.stringify(start).includes('hidden-fixture-token'));
    assert.equal(turns[0].params.permissions, start.permissions);
    assert.equal(start.config.permissions[start.permissions].filesystem[':root'], 'deny');
    assert.equal(start.config.permissions[start.permissions].filesystem[start.cwd], 'read');
  } finally { await respond.close(); }
});

test('complete validated bubbles are delivered before turn completion', async () => {
  const server = fakeCodexServer({ plans: [{ shouldReply: true, messages: [{ content: 'First answer', gifUrl: null, stickerIds: [] }, { content: 'Extra detail', gifUrl: null, stickerIds: [] }] }], delayMs: 15 });
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl });
  const delivered = [];
  try {
    const result = await respond(context, undefined, { onMessage: async (message, index) => { delivered.push({ content: message.content, index, finished: server.completedTurns() }); } });
    assert.equal(delivered[0].finished, 0);
    assert.deepEqual(delivered.map((message) => message.content), ['First answer', 'Extra detail']);
    assert.deepEqual(delivered.map((message) => message.index), [0, 1]);
    assert.equal(result.messages.length, 2);
  } finally { await respond.close(); }
});

test('a private thread cannot be reused for another Discord conversation', async () => {
  const server = fakeCodexServer();
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl });
  try {
    await respond(context);
    await assert.rejects(() => respond({ ...context, channelId: '200000000000000002', directMessages: false }), /Cannot share/);
    assert.equal(server.requests.filter((request) => request.method === 'turn/start').length, 1);
  } finally { await respond.close(); }
});

test('streamed messages are validated before delivery and unexpected MCP tools block startup', async () => {
  const server = fakeCodexServer({ plans: [{ shouldReply: true, messages: [{ content: '<:invented:300000000000000009>', stickerIds: [], gifUrl: null }] }] });
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl });
  let delivered = 0;
  try { await assert.rejects(() => respond(context, undefined, { onMessage: async () => { delivered += 1; } }), /unavailable custom emoji/); assert.equal(delivered, 0); }
  finally { await respond.close(); }
  const unsafe = createCodexResponder({ spawnImpl: fakeCodexServer({ tools: { dangerous: {} } }).spawnImpl });
  try { await assert.rejects(() => unsafe.warmup(), /unexpectedly loaded MCP tools/); }
  finally { await unsafe.close(); }
});

test('explicit model and speed overrides reach every turn', async () => {
  const server = fakeCodexServer();
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl, model: 'fixture-model', reasoningEffort: 'high', serviceTier: 'default' });
  try {
    await respond(context);
    const turn = server.requests.find((request) => request.method === 'turn/start').params;
    assert.equal(turn.model, 'fixture-model'); assert.equal(turn.effort, 'high'); assert.equal(turn.serviceTier, 'default');
  } finally { await respond.close(); }
});

test('cancellation interrupts the active turn and prevents late bubble delivery', async () => {
  const server = fakeCodexServer({ hang: true });
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl });
  const cancellation = new AbortController();
  try {
    await respond.warmup();
    const result = respond(context, cancellation.signal);
    const rejected = assert.rejects(result, /stopped/);
    for (let attempt = 0; attempt < 100 && !server.requests.some((request) => request.method === 'turn/start'); attempt += 1) await setTimeout(2);
    cancellation.abort();
    await rejected;
    assert.ok(server.requests.some((request) => request.method === 'turn/interrupt'));
    assert.equal(respond.status().threadId, 'thread-1');
    assert.equal(respond.status().performance.counters.retained_threads, 1);
  } finally { await respond.close(); }
});

test('stream and final validation reuse one catalog while preserving rejection rules', () => {
  let catalogReads = 0;
  const expression = { get markup() { catalogReads += 1; return '<:wave:300000000000000001>'; } };
  const validator = createReplyValidator({ expressions: { emojis: [expression], stickers: [] }, allowedGifUrls: [] });
  const bubble = { content: 'hello <:wave:300000000000000001>', gifUrl: null, stickerIds: [] };
  for (let index = 0; index < 5; index += 1) validator.message(bubble);
  const plan = validator.plan({ shouldReply: true, messages: Array.from({ length: 5 }, () => bubble) });
  assert.equal(plan.messages.length, 5);
  assert.equal(catalogReads, 1);
  assert.throws(() => validator.message({ ...bubble, content: '<:missing:300000000000000002>' }), /unavailable custom emoji/);
});

test('old-worker cleanup cannot delete a replacement worker directory during concurrent warmup', async () => {
  const server = fakeCodexServer({ closeDelayMs: 30 });
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl });
  try {
    await respond.warmup();
    const oldDirectory = server.launches[0].options.cwd;
    server.children[0].stdin.emit('error', new Error('Lost pipe'));
    await Promise.all([respond.warmup(), respond.warmup()]);
    assert.equal(server.launches.length, 2);
    assert.equal((await stat(server.launches[1].options.cwd)).isDirectory(), true);
    await assert.rejects(() => stat(oldDirectory), { code: 'ENOENT' });
    await respond(context);
  } finally { await respond.close(); }
});
