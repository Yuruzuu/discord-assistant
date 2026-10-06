import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppServer } from '../src/proactive/app-server.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

test('concurrent transport shutdown reuses one close operation and terminates the child once', async () => {
  const fixture = fakeCodexServer({ closeDelayMs: 10 });
  const server = createAppServer({ command: 'fixture', spawnImpl: fixture.spawnImpl });
  let kills = 0;
  const kill = fixture.children[0].kill;
  fixture.children[0].kill = (...args) => { kills += 1; return kill(...args); };
  const first = server.close();
  const second = server.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await server.close();
  assert.equal(kills, 1);
});

test('an already exited worker does not incur the shutdown timeout or another signal', async () => {
  const fixture = fakeCodexServer();
  const server = createAppServer({ command: 'fixture', spawnImpl: fixture.spawnImpl });
  const child = fixture.children[0];
  child.signalCode = 'SIGTERM';
  child.emit('close', null);
  let kills = 0;
  child.kill = () => { kills += 1; };
  let closed = false;
  const closing = server.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, true);
  await closing;
  assert.equal(kills, 0);
});

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { appServerTimeout } from '../src/proactive/app-server.mjs';

function manualServer({ holdWrites = false, writeFailure = false, limits, onNotification, onToolCall, onLateResponse, onFailure } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const written = [];
  const callbacks = [];
  child.stdin = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
    written.push(JSON.parse(chunk.toString()));
    if (holdWrites) callbacks.push(callback);
    else callback(writeFailure ? new Error('SECRET_NATIVE_TOKEN') : undefined);
  } });
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
  const server = createAppServer({ command: 'fixture', spawnImpl: () => child, limits, onNotification, onToolCall, onLateResponse, onFailure });
  return { server, child, written, callbacks, respond(id, result) { child.stdout.write(JSON.stringify({ id, result }) + '\n'); } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('method budgets distinguish startup, controls, and compaction', () => {
  assert.equal(appServerTimeout('initialize'), 60000);
  assert.equal(appServerTimeout('thread/start'), 60000);
  assert.equal(appServerTimeout('turn/interrupt'), 5000);
  assert.equal(appServerTimeout('thread/compact/start'), 120000);
  assert.equal(appServerTimeout('turn/start'), 15000);
});

test('timeouts preserve written identity and surface late native results without replay', async () => {
  const late = [];
  const fixture = manualServer({ onLateResponse: (response) => late.push(response) });
  try {
    await assert.rejects(fixture.server.request('turn/start', { threadId: 'owned' }, 10), (error) => error.code === 'CODEX_REQUEST_TIMEOUT' && error.writeOutcome === 'written');
    fixture.respond(fixture.written[0].id, { turn: { id: 'native-turn' } });
    await tick();
    assert.equal(fixture.written.length, 1);
    assert.equal(late[0].method, 'turn/start');
    assert.equal(late[0].params.threadId, 'owned');
    assert.equal(late[0].result.turn.id, 'native-turn');
    assert.equal(late[0].writeOutcome, 'written');
  } finally { await fixture.server.close(); }
});

test('abort before write has a definitive outcome and expired absolute budgets never write', async () => {
  const fixture = manualServer();
  const cancellation = new AbortController(); cancellation.abort();
  try {
    await assert.rejects(fixture.server.request('turn/start', {}, { signal: cancellation.signal }), (error) => error.writeOutcome === 'not-written');
    await assert.rejects(fixture.server.request('turn/start', {}, { deadlineAt: Date.now() - 1 }), (error) => error.code === 'CODEX_REQUEST_TIMEOUT' && error.writeOutcome === 'not-written');
    assert.equal(fixture.written.length, 0);
  } finally { await fixture.server.close(); }
});

test('backpressure prevents a queued aborted mutation from reaching the child', async () => {
  const fixture = manualServer({ holdWrites: true });
  const cancellation = new AbortController();
  const first = fixture.server.request('account/read', {}, 1000);
  const second = fixture.server.request('turn/start', {}, { signal: cancellation.signal });
  const rejected = assert.rejects(second, (error) => error.code === 'CODEX_REQUEST_ABORTED' && error.writeOutcome === 'not-written');
  cancellation.abort();
  await rejected;
  fixture.callbacks.shift()();
  await tick();
  fixture.respond(fixture.written[0].id, {});
  await first;
  assert.equal(fixture.written.length, 1);
  await fixture.server.close();
});

test('a cancelled written request still reports its late native identity', async () => {
  const late = [];
  const fixture = manualServer({ onLateResponse: (response) => late.push(response) });
  const cancellation = new AbortController();
  const operation = fixture.server.request('turn/start', {}, { signal: cancellation.signal });
  const rejected = assert.rejects(operation, (error) => error.code === 'CODEX_REQUEST_ABORTED' && error.writeOutcome !== 'not-written');
  cancellation.abort(); await rejected;
  fixture.respond(fixture.written[0].id, { turn: { id: 'late' } });
  await tick();
  assert.equal(late[0].result.turn.id, 'late');
  await fixture.server.close();
});

test('stdin write failures reject pending calls without exposing raw native secrets', async () => {
  const fixture = manualServer({ writeFailure: true });
  await assert.rejects(fixture.server.request('turn/start', {}), (error) => error.code === 'CODEX_WRITE_FAILED' && error.writeOutcome === 'unknown' && !error.message.includes('SECRET_NATIVE_TOKEN'));
  await fixture.server.close();
});

test('malformed and oversized protocol frames fail instead of leaving requests hanging', async () => {
  for (const payload of ['not-json\n', JSON.stringify({ id: 1, result: 'x'.repeat(1024) }) + '\n', JSON.stringify({ result: 1 }) + '\n']) {
    const fixture = manualServer({ limits: { frameBytes: 256 } });
    const pending = fixture.server.request('read', {});
    const rejected = assert.rejects(pending, (error) => error.code === 'CODEX_PROTOCOL_ERROR');
    fixture.child.stdout.write(payload);
    await rejected;
    assert.equal(fixture.server.isClosed(), true);
    await fixture.server.close();
  }
});

test('outbound frame and unresolved-request caps reject definitively before write', async () => {
  const fixture = manualServer({ limits: { frameBytes: 256, pendingRequests: 1 } });
  try {
    await assert.rejects(fixture.server.request('turn/start', { content: 'x'.repeat(1024) }), (error) => error.code === 'CODEX_OUTBOUND_LIMIT' && error.writeOutcome === 'not-written');
    const first = fixture.server.request('turn/start', {}, 10);
    await assert.rejects(first, { code: 'CODEX_REQUEST_TIMEOUT' });
    await assert.rejects(fixture.server.request('turn/start', {}), (error) => error.code === 'CODEX_PENDING_LIMIT' && error.writeOutcome === 'not-written');
    fixture.respond(fixture.written[0].id, {});
    await tick();
    const next = fixture.server.request('read', {});
    fixture.respond(fixture.written[1].id, {});
    await next;
  } finally { await fixture.server.close(); }
});

test('slow tool callbacks cannot block other thread notifications or responses', async () => {
  const notifications = [];
  let release;
  const toolGate = new Promise((resolve) => { release = resolve; });
  const fixture = manualServer({ onToolCall: () => toolGate, onNotification: (method, params) => notifications.push(params.threadId) });
  const pending = fixture.server.request('read', {});
  fixture.child.stdout.write(JSON.stringify({ id: 'tool-1', method: 'item/tool/call', params: { threadId: 'one' } }) + '\n');
  fixture.child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'two' } }) + '\n');
  fixture.respond(fixture.written[0].id, { done: true });
  assert.deepEqual(await pending, { done: true });
  assert.deepEqual(notifications, ['two']);
  release({ success: true }); await tick();
  await fixture.server.close();
});

test('pending request byte budgets include written requests until their native response', async () => {
  const fixture = manualServer({ limits: { pendingBytes: 300 } });
  try {
    const first = fixture.server.request('read', { content: 'x'.repeat(150) });
    await assert.rejects(fixture.server.request('read', { content: 'x'.repeat(150) }), (error) => error.code === 'CODEX_PENDING_LIMIT' && error.writeOutcome === 'not-written');
    fixture.respond(fixture.written[0].id, {}); await first;
    const next = fixture.server.request('read', { content: 'x'.repeat(150) });
    await tick();
    fixture.respond(fixture.written[1].id, {}); await next;
  } finally { await fixture.server.close(); }
});

test('inbound tool byte budgets bound callbacks awaiting host tools', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fixture = manualServer({ limits: { inboundBytes: 300 }, onToolCall: () => blocked });
  const pending = fixture.server.request('read', {});
  const rejected = assert.rejects(pending, { code: 'CODEX_PROTOCOL_ERROR' });
  for (const id of [1, 2]) fixture.child.stdout.write(JSON.stringify({ id: `tool-${id}`, method: 'item/tool/call', params: { text: 'x'.repeat(150) } }) + '\n');
  await rejected;
  release({ success: false }); await tick();
  await fixture.server.close();
});

test('split Unicode protocol frames preserve non-ASCII native results', async () => {
  const fixture = manualServer();
  const pending = fixture.server.request('read', {});
  const bytes = Buffer.from(JSON.stringify({ id: fixture.written[0].id, result: '🦊こんにちは' }) + '\n');
  for (const byte of bytes) fixture.child.stdout.write(Buffer.from([byte]));
  assert.equal(await pending, '🦊こんにちは');
  await fixture.server.close();
});
