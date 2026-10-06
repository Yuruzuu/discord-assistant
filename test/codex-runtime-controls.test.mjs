import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createConversationReply } from '../src/proactive/conversation.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

const context = { channelId: '111111111111111111', guildId: null, directMessages: true, recentMessages: [], triggerMessages: [], expressions: { emojis: [], stickers: [] }, gifs: [] };
const secondContext = { ...context, channelId: '222222222222222222' };
const readingTools = (call) => ({ definitions: [{ name: 'lookup', description: 'Read context', inputSchema: { type: 'object' } }], has: (name) => name === 'lookup', call, errorMessage: (error) => error.message });

async function waitForTurn(fixture) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fixture.requests.some((entry) => entry.method === 'turn/start')) return;
    await wait(1);
  }
  throw new Error('The fixture did not start a turn');
}

test('shared workers retain isolated threads and closing one conversation does not stop siblings', async () => {
  const fixture = fakeCodexServer();
  const first = createConversationReply({ spawnImpl: fixture.spawnImpl });
  const second = createConversationReply({ spawnImpl: fixture.spawnImpl });
  try {
    await Promise.all([first(context), second(secondContext)]);
    assert.equal(fixture.launches.length, 1);
    assert.notEqual(first.status().threadId, second.status().threadId);
    assert.equal(first.status().sharedWorkerConversations, 2);
    assert.equal(fixture.requests.filter((entry) => entry.method === 'initialize').length, 1);
    await first.close();
    assert.equal(fixture.children[0].exitCode, null);
    await second(secondContext);
    assert.equal(second.status().turns, 2);
    assert.equal(second.status().sharedWorkerConversations, 1);
  } finally { await Promise.all([first.close(), second.close()]); }
  assert.equal(fixture.children[0].exitCode, 0);
});

test('dynamic tools are routed to their owning conversation even on a shared worker', async () => {
  const fixture = fakeCodexServer({ toolCalls: [{ tool: 'lookup' }] });
  const seen = [];
  const first = createConversationReply({ spawnImpl: fixture.spawnImpl, readTools: readingTools(async () => { seen.push('first'); return { success: true, contentItems: [{ type: 'inputText', text: 'first private result' }] }; }) });
  const second = createConversationReply({ spawnImpl: fixture.spawnImpl, readTools: readingTools(async () => { seen.push('second'); return { success: true, contentItems: [{ type: 'inputText', text: 'second private result' }] }; }) });
  try {
    await Promise.all([first(context), second(secondContext)]);
    assert.deepEqual(seen.sort(), ['first', 'second']);
    assert.equal(fixture.toolResponses.length, 2);
  } finally { await Promise.all([first.close(), second.close()]); }
});

test('steering uses the active turn precondition and interrupt affects only that conversation', async () => {
  const fixture = fakeCodexServer({ hang: true });
  const first = createConversationReply({ spawnImpl: fixture.spawnImpl });
  const second = createConversationReply({ spawnImpl: fixture.spawnImpl });
  try {
    await second.warmup();
    const pending = first(context);
    const rejected = assert.rejects(pending, /interrupted/);
    await waitForTurn(fixture);
    const steering = await first.steer('Only search the mobile controls', { clientUserMessageId: '123' });
    assert.equal(steering.accepted, true);
    const request = fixture.requests.find((entry) => entry.method === 'turn/steer');
    assert.equal(request.params.expectedTurnId, 'turn-1');
    assert.equal(request.params.threadId, first.status().threadId);
    await assert.rejects(first.configure({ model: 'another' }), /Stop the active/);
    await first.interrupt();
    await rejected;
    assert.equal(fixture.children[0].exitCode, null);
    assert.equal(second.status().sharedWorkerConversations, 2);
    assert.equal(first.status().threadId, request.params.threadId);
    assert.equal(first.status().performance.counters.retained_threads, 1);
    assert.equal((await first.steer('Late correction')).accepted, false);
  } finally { await Promise.all([first.close(), second.close()]); }
});

test('diagnostics expose authentication type and usage without account identity or credentials', async () => {
  const fixture = fakeCodexServer();
  const respond = createConversationReply({ spawnImpl: fixture.spawnImpl });
  try {
    const diagnostics = await respond.diagnostics();
    assert.equal(diagnostics.authType, 'chatgpt');
    assert.equal(diagnostics.rateLimits.primary.usedPercent, 25);
    assert.equal(diagnostics.actualServiceTier, null);
    assert.equal(diagnostics.models[0].model, 'fixture-model');
    assert.equal(JSON.stringify(diagnostics).includes('private@example.test'), false);
    assert.equal(JSON.stringify(diagnostics).includes('hidden-fixture-token'), false);
    assert.equal(fixture.requests.some((entry) => entry.method === 'turn/start'), false);
  } finally { await respond.close(); }
});

test('bounded owner configuration changes reach turns and reset drops only the conversation thread', async () => {
  const fixture = fakeCodexServer();
  const respond = createConversationReply({ spawnImpl: fixture.spawnImpl });
  try {
    await respond.configure({ model: 'fixture-choice', reasoningEffort: 'high', serviceTier: 'default', timeoutMs: 180000, maxToolCalls: 12 });
    await respond(context);
    const firstThread = respond.status().threadId;
    const turn = fixture.requests.find((entry) => entry.method === 'turn/start');
    assert.equal(turn.params.model, 'fixture-choice');
    assert.equal(turn.params.effort, 'high');
    assert.equal(turn.params.serviceTier, 'default');
    await assert.rejects(respond.configure({ timeoutMs: Infinity }), /Timeout/);
    await assert.rejects(respond.configure({ accountId: 'other' }), /Unsupported/);
    await respond.compact();
    assert.equal(fixture.requests.some((entry) => entry.method === 'thread/compact/start'), true);
    await respond.reset();
    await respond(context);
    assert.notEqual(respond.status().threadId, firstThread);
    assert.equal(respond.status().turns, 1);
  } finally { await respond.close(); }
});

test('catalog refresh recreates an idle thread and image input uses the supported Codex schema', async () => {
  const fixture = fakeCodexServer();
  const tools = readingTools(async () => ({ success: true, contentItems: [] }));
  const respond = createConversationReply({ spawnImpl: fixture.spawnImpl, readTools: tools });
  try {
    await respond(context);
    const previous = respond.status().threadId;
    tools.definitions.push({ name: 'new_read', description: 'New controlled tool', inputSchema: { type: 'object' } });
    await respond({ ...context, images: [{ imageUrl: 'data:image/png;base64,YQ==', sourceMessageId: '1' }] });
    assert.notEqual(respond.status().threadId, previous);
    const turn = fixture.requests.filter((entry) => entry.method === 'turn/start').at(-1);
    assert.deepEqual(turn.params.input[1], { type: 'image', url: 'data:image/png;base64,YQ==' });
    assert.equal(turn.params.input[0].text.includes('base64'), false);
  } finally { await respond.close(); }
});

test('repeated failing tool arguments stop retries while the turn can report its findings', async () => {
  const fixture = fakeCodexServer({ toolCalls: Array.from({ length: 5 }, () => ({ tool: 'lookup', arguments: { query: 'missing' } })) });
  let calls = 0;
  const respond = createConversationReply({ spawnImpl: fixture.spawnImpl, readTools: readingTools(async () => { calls += 1; throw new Error('No access'); }) });
  try {
    await respond(context);
    assert.equal(calls, 3);
    assert.equal(fixture.toolResponses.length, 5);
    assert.match(fixture.toolResponses.at(-1).result.contentItems[0].text, /repeatedly failed/);
  } finally { await respond.close(); }
});

test('a hanging tool has its own deadline without discarding the entire answer', async () => {
  const fixture = fakeCodexServer({ toolCalls: [{ tool: 'lookup' }] });
  const respond = createConversationReply({ spawnImpl: fixture.spawnImpl, toolTimeoutMs: 10, readTools: readingTools(() => new Promise(() => {})) });
  try {
    await respond(context);
    assert.equal(fixture.toolResponses[0].result.success, false);
    assert.match(fixture.toolResponses[0].result.contentItems[0].text, /timeout/i);
  } finally { await respond.close(); }
});

test('identical successful results stop pointless repeated reads and changing arguments remains available', async () => {
  const fixture = fakeCodexServer({ toolCalls: [...Array.from({ length: 5 }, () => ({ tool: 'lookup', arguments: { query: 'same' } })), { tool: 'lookup', arguments: { query: 'different' } }] });
  let calls = 0;
  const respond = createConversationReply({ spawnImpl: fixture.spawnImpl, readTools: readingTools(async () => { calls += 1; return { success: true, contentItems: [{ type: 'inputText', text: 'unchanged' }] }; }) });
  try {
    await respond(context);
    assert.equal(calls, 4);
    assert.match(fixture.toolResponses[4].result.contentItems[0].text, /same result/);
    assert.equal(fixture.toolResponses[5].result.success, true);
  } finally { await respond.close(); }
});

test('image sources retain message attribution without embedding private bytes into text context', async () => {
  const fixture = fakeCodexServer();
  const first = createConversationReply({ spawnImpl: fixture.spawnImpl });
  const second = createConversationReply({ spawnImpl: fixture.spawnImpl });
  try {
    await first({ ...context, images: [{ sourceMessageId: '1555972640768790731', imageUrl: 'data:image/png;base64,YQ==' }, { sourceMessageId: '1555972640768790732', imageUrl: 'data:image/jpeg;base64,Yg==' }] });
    await second(secondContext);
    const turns = fixture.requests.filter((request) => request.method === 'turn/start');
    const textContext = JSON.parse(turns[0].params.input[0].text);
    assert.deepEqual(textContext.imageSources, [{ index: 0, sourceMessageId: '1555972640768790731' }, { index: 1, sourceMessageId: '1555972640768790732' }]);
    assert.equal(turns[0].params.input[0].text.includes('base64'), false);
    assert.equal(turns[0].params.input[1].url, 'data:image/png;base64,YQ==');
    assert.equal(turns[1].params.input.length, 1);
    assert.equal(turns[1].params.input[0].text.includes('1555972640768790731'), false);
    await first({ ...context, images: [{ sourceMessageId: '1555972640768790731', imageUrl: 'data:image/png;base64,YQ==' }] });
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/start').at(-1).params.input.length, 2);
  } finally { await Promise.all([first.close(), second.close()]); }
});

test('subscription preflight accepts ChatGPT login and rejects API-key or absent authentication before a thread starts', async () => {
  for (const accountType of ['chatgpt', 'apiKey', null]) {
    const fixture = fakeCodexServer({ accountType });
    const respond = createConversationReply({ spawnImpl: fixture.spawnImpl, requireSubscription: true });
    try {
      if (accountType === 'chatgpt') { await respond.warmup(); assert.equal(respond.status().authType, 'chatgpt'); }
      else {
        await assert.rejects(respond.warmup(), /saved ChatGPT subscription login/);
        assert.equal(fixture.requests.some((request) => request.method === 'thread/start'), false);
        assert.equal(fixture.children[0].exitCode, 0);
      }
    } finally { await respond.close(); }
  }
});
