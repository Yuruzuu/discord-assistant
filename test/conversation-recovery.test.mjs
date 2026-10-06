import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexResponder } from '../src/proactive/codex-responder.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

const context = { channelId: '200000000000000001', guildId: null, directMessages: true, expressions: { emojis: [], stickers: [] }, allowedGifUrls: [], recentMessages: [], triggerMessages: [] };

async function started(fixture, count = 1) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fixture.requests.filter((request) => request.method === 'turn/start').length >= count) return;
    await delay(1);
  }
  assert.fail('Fixture did not receive a native turn/start');
}

function intercept(fixture, transform) {
  return (command, args, options) => {
    const child = fixture.spawnImpl(command, args, options);
    const write = child.stdout.write.bind(child.stdout);
    child.stdout.write = (chunk, ...rest) => {
      const message = JSON.parse(chunk.toString());
      const result = transform(message, fixture, (value) => write(JSON.stringify(value) + '\n'));
      if (result === null) return true;
      return write(JSON.stringify(result || message) + '\n', ...rest);
    };
    return child;
  };
}

test('confirmed cancellation retains the warm thread and permits the next answer', async () => {
  const fixture = fakeCodexServer({ delayMs: 30 });
  const respond = createCodexResponder({ spawnImpl: fixture.spawnImpl, settlementTimeoutMs: 40 });
  const cancellation = new AbortController();
  try {
    await respond.warmup();
    const threadId = respond.status().threadId;
    const rejected = assert.rejects(respond(context, cancellation.signal), /stopped|abort|cancel/i);
    await started(fixture);
    cancellation.abort(); await rejected;
    assert.equal(respond.status().threadId, threadId);
    const answer = await respond(context);
    assert.equal(answer.shouldReply, true);
    assert.equal(respond.status().threadId, threadId);
    assert.equal(respond.status().cachedInputTokens, 1024);
    assert.equal(fixture.requests.filter((request) => request.method === 'thread/start').length, 1);
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/start').length, 2);
  } finally { await respond.close(); }
});

test('unconfirmed cancellation retires only the unsafe conversation while its peer stays alive', async () => {
  const fixture = fakeCodexServer({ hang: true, interruptCompletes: false });
  const first = createCodexResponder({ spawnImpl: fixture.spawnImpl, settlementTimeoutMs: 10 });
  const peer = createCodexResponder({ spawnImpl: fixture.spawnImpl, settlementTimeoutMs: 10 });
  const cancellation = new AbortController();
  try {
    await first.warmup(); await peer.warmup();
    const oldFirst = first.status().threadId;
    const peerThread = peer.status().threadId;
    const rejected = assert.rejects(first(context, cancellation.signal), /stopped|abort|cancel/i);
    await started(fixture);
    cancellation.abort(); await rejected;
    assert.equal(first.status().threadId, null);
    assert.equal(peer.status().threadId, peerThread);
    assert.equal(fixture.children[0].exitCode, null);
    await first.warmup();
    assert.notEqual(first.status().threadId, oldFirst);
    assert.equal(peer.status().threadId, peerThread);
    assert.equal(fixture.launches.length, 1);
  } finally { await first.close(); await peer.close(); }
});

test('native failed and interrupted terminal outcomes retain a healthy thread', async () => {
  for (const status of ['failed', 'interrupted']) {
    const fixture = fakeCodexServer();
    let changed = false;
    const spawnImpl = intercept(fixture, (message) => {
      if (!changed && message.method === 'turn/completed') { changed = true; return { ...message, params: { ...message.params, turn: { ...message.params.turn, status } } }; }
    });
    const respond = createCodexResponder({ spawnImpl, settlementTimeoutMs: 20 });
    try {
      await respond.warmup();
      const threadId = respond.status().threadId;
      await assert.rejects(respond(context), new RegExp(status));
      assert.equal(respond.status().threadId, threadId);
      await respond(context);
      assert.equal(respond.status().threadId, threadId);
      assert.equal(fixture.requests.filter((request) => request.method === 'thread/start').length, 1);
    } finally { await respond.close(); }
  }
});

test('malformed terminal notifications do not confirm cancellation or permit warm reuse', async () => {
  const fixture = fakeCodexServer({ hang: true });
  const spawnImpl = intercept(fixture, (message) => {
    if (message.method === 'turn/completed') return { ...message, params: { ...message.params, turn: { id: message.params.turn.id, status: 'unconfirmed' } } };
  });
  const respond = createCodexResponder({ spawnImpl, settlementTimeoutMs: 10 });
  const cancellation = new AbortController();
  try {
    await respond.warmup();
    const rejected = assert.rejects(respond(context, cancellation.signal), /stopped|abort|cancel/i);
    await started(fixture); cancellation.abort(); await rejected;
    assert.equal(respond.status().threadId, null);
  } finally { await respond.close(); }
});

test('invalid reply plans are fatal and rotate their native conversation', async () => {
  const fixture = fakeCodexServer({ plans: [{ shouldReply: true, messages: [{ content: '<:invented:300000000000000009>', gifUrl: null, stickerIds: [] }] }] });
  const respond = createCodexResponder({ spawnImpl: fixture.spawnImpl, settlementTimeoutMs: 20 });
  try {
    await respond.warmup(); const threadId = respond.status().threadId;
    await assert.rejects(respond(context, undefined, { onMessage: async () => {} }), /unavailable custom emoji/);
    assert.equal(respond.status().threadId, null);
    await respond.warmup(); assert.notEqual(respond.status().threadId, threadId);
  } finally { await respond.close(); }
});

test('partial delivery failures never retry published bubbles or native writes automatically', async () => {
  const fixture = fakeCodexServer({ delayMs: 20, plans: [{ shouldReply: true, messages: [{ content: 'first', gifUrl: null, stickerIds: [] }, { content: 'second', gifUrl: null, stickerIds: [] }] }] });
  const respond = createCodexResponder({ spawnImpl: fixture.spawnImpl, settlementTimeoutMs: 20 });
  const attempted = [];
  try {
    await respond.warmup(); const threadId = respond.status().threadId;
    await assert.rejects(respond(context, undefined, { onMessage: async (message) => { attempted.push(message.content); if (message.content === 'second') throw new Error('Delivery outcome unknown'); } }), /Delivery outcome unknown/);
    assert.deepEqual(attempted, ['first', 'second']);
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/start').length, 1);
    assert.equal(respond.status().threadId, threadId);
  } finally { await respond.close(); }
});

test('late native start acknowledgement is owned and interrupted without replay', async () => {
  const fixture = fakeCodexServer({ hang: true });
  let observedLate = false;
  const spawnImpl = intercept(fixture, (message, server, emit) => {
    if (message.id !== undefined && server.requests.find((request) => request.id === message.id)?.method === 'turn/start') {
      setTimeout(() => { observedLate = true; emit(message); }, 15);
      return null;
    }
  });
  const respond = createCodexResponder({ spawnImpl, settlementTimeoutMs: 50 });
  const cancellation = new AbortController();
  try {
    await respond.warmup(); const threadId = respond.status().threadId;
    const rejected = assert.rejects(respond(context, cancellation.signal), /stopped|abort|cancel/i);
    await started(fixture); cancellation.abort(); await rejected;
    assert.equal(observedLate, true);
    assert.equal(respond.status().threadId, threadId);
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/start').length, 1);
    const interrupts = fixture.requests.filter((request) => request.method === 'turn/interrupt');
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0].params.turnId, 'turn-1');
  } finally { await respond.close(); }
});

test('stale completed-turn tool callbacks cannot execute during the next admission', async () => {
  const fixture = fakeCodexServer();
  let toolCalls = 0;
  const readTools = { definitions: [], has: (name) => name === 'fixture_read', call: async () => { toolCalls += 1; return { success: true, contentItems: [{ type: 'inputText', text: 'read' }] }; }, errorMessage: () => 'read failed' };
  const spawnImpl = intercept(fixture, (message, server, emit) => {
    const request = server.requests.find((entry) => entry.id === message.id);
    if (message.id !== undefined && request?.method === 'turn/start' && server.requests.filter((entry) => entry.method === 'turn/start').length === 2) {
      emit({ id: 'old-tool-request', method: 'item/tool/call', params: { threadId: request.params.threadId, turnId: 'turn-1', callId: 'stale-call', tool: 'fixture_read', arguments: {} } });
    }
  });
  const respond = createCodexResponder({ spawnImpl, readTools, settlementTimeoutMs: 20 });
  try {
    await respond(context);
    await respond(context);
    assert.equal(toolCalls, 0);
    assert.equal(fixture.requests.filter((request) => request.method === 'thread/start').length, 1);
  } finally { await respond.close(); }
});

test('definitive pre-write cancellation preserves a healthy thread without native settlement or replay', async () => {
  const fixture = fakeCodexServer();
  const cancellation = new AbortController();
  const { createStageMetrics } = await import('../src/proactive/stage-metrics.mjs');
  const metrics = createStageMetrics();
  const originalStart = metrics.start;
  let cancelBeforeWrite = true;
  metrics.start = (stage) => {
    if (stage === 'native_execution' && cancelBeforeWrite) { cancelBeforeWrite = false; cancellation.abort(); }
    return originalStart(stage);
  };
  const respond = createCodexResponder({ spawnImpl: fixture.spawnImpl, metrics, settlementTimeoutMs: 1000 });
  try {
    await respond.warmup(); const threadId = respond.status().threadId;
    await assert.rejects(respond(context, cancellation.signal), (error) => error.code === 'CODEX_REQUEST_ABORTED' && error.writeOutcome === 'not-written');
    assert.equal(respond.status().threadId, threadId);
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/start').length, 0);
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/interrupt').length, 0);
    assert.equal(respond.status().performance.counters.retained_threads, 1);
    assert.equal(respond.status().performance.counters.retired_threads, undefined);
    await respond(context);
    assert.equal(respond.status().threadId, threadId);
    assert.equal(fixture.requests.filter((request) => request.method === 'thread/start').length, 1);
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/start').length, 1);
  } finally { await respond.close(); }
});

test('provider configuration changes rotate a previously failed native thread while budget changes retain it', async () => {
  const fixture = fakeCodexServer();
  let failed = false;
  const spawnImpl = intercept(fixture, (message) => {
    if (!failed && message.method === 'turn/completed') { failed = true; return { ...message, params: { ...message.params, turn: { ...message.params.turn, status: 'failed' } } }; }
  });
  const respond = createCodexResponder({ spawnImpl, settlementTimeoutMs: 20 });
  try {
    await respond.warmup(); const failedThread = respond.status().threadId;
    await assert.rejects(respond(context), /failed/);
    await respond.configure({ timeoutMs: 1000 });
    assert.equal(respond.status().threadId, failedThread);
    await respond.configure({ model: 'replacement-model' });
    assert.equal(respond.status().threadId, null);
    await respond.warmup();
    assert.notEqual(respond.status().threadId, failedThread);
    await respond(context);
    const request = fixture.requests.filter((entry) => entry.method === 'turn/start').at(-1);
    assert.equal(request.params.model, 'replacement-model');
    assert.equal(fixture.requests.filter((entry) => entry.method === 'thread/start').length, 2);
  } finally { await respond.close(); }
});

test('explicit native compaction refreshes projected snapshots and message watermarks without rotating the thread', async () => {
  const fixture = fakeCodexServer();
  const respond = createCodexResponder({ spawnImpl: fixture.spawnImpl });
  const repeated = { ...context, approvedMemory: 'approved-owner-memory '.repeat(100), recentMessages: [{ id: '500000000000000001', content: 'context' }] };
  try {
    await respond(repeated); const threadId = respond.status().threadId;
    await respond(repeated);
    const secondInput = JSON.parse(fixture.requests.filter((entry) => entry.method === 'turn/start').at(-1).params.input[0].text);
    assert.equal(Object.hasOwn(secondInput, 'approvedMemory'), false);
    assert.equal(secondInput.recentMessages.length, 0);
    await respond.compact();
    await respond(repeated);
    const refreshedInput = JSON.parse(fixture.requests.filter((entry) => entry.method === 'turn/start').at(-1).params.input[0].text);
    assert.equal(refreshedInput.approvedMemory, repeated.approvedMemory);
    assert.equal(refreshedInput.recentMessages.length, 1);
    assert.equal(respond.status().threadId, threadId);
    assert.equal(fixture.requests.filter((entry) => entry.method === 'thread/compact/start').length, 1);
    assert.equal(fixture.requests.filter((entry) => entry.method === 'thread/start').length, 1);
  } finally { await respond.close(); }
});

test('an uncooperative delivery promise cannot outlive the answer deadline indefinitely', async () => {
  const fixture = fakeCodexServer();
  const respond = createCodexResponder({ spawnImpl: fixture.spawnImpl, timeoutMs: 80, settlementTimeoutMs: 10 });
  let releaseDelivery;
  const delivery = new Promise((resolve) => { releaseDelivery = resolve; });
  let outcome;
  let deadline;
  try {
    await respond.warmup(); const threadId = respond.status().threadId;
    outcome = respond(context, undefined, { onMessage: async () => delivery }).then((value) => ({ value }), (error) => ({ error }));
    const bounded = await Promise.race([outcome, new Promise((resolve) => { deadline = setTimeout(() => resolve(null), 500); })]);
    clearTimeout(deadline);
    assert.ok(bounded?.error, 'Answer must reject within its deadline even when delivery ignores cancellation');
    assert.equal(bounded.error.code, 'NOVA_TURN_TIMEOUT');
    assert.equal(fixture.completedTurns(), 1);
    assert.equal(respond.status().threadId, threadId);
    assert.equal(fixture.requests.filter((entry) => entry.method === 'turn/start').length, 1);
  } finally { clearTimeout(deadline); releaseDelivery(); if (outcome) await outcome; await respond.close(); }
});
