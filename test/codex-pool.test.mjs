import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireCodexServer } from '../src/proactive/codex-pool.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

function delayedResponses(fixture, method, delayMs) {
  return (command, args, options) => {
    const child = fixture.spawnImpl(command, args, options);
    const originalWrite = child.stdout.write.bind(child.stdout);
    child.stdout.write = (chunk, ...rest) => {
      const message = JSON.parse(chunk.toString());
      if (message.id !== undefined && fixture.requests.find((request) => request.id === message.id)?.method === method) {
        setTimeout(() => { if (child.exitCode === null) originalWrite(chunk, ...rest); }, delayMs);
        return true;
      }
      return originalWrite(chunk, ...rest);
    };
    return child;
  };
}

const options = (fixture, additional = {}) => ({ command: 'fixture', env: {}, spawnImpl: fixture.spawnImpl, onNotification: () => {}, onToolCall: () => ({ success: true }), onFailure: () => {}, ...additional });

test('cancelling one shared startup caller leaves the other owner and worker alive', async () => {
  const fixture = fakeCodexServer();
  const spawnImpl = delayedResponses(fixture, 'initialize', 30);
  const cancellation = new AbortController();
  const first = acquireCodexServer(options(fixture, { spawnImpl, signal: cancellation.signal }));
  const second = acquireCodexServer(options(fixture, { spawnImpl }));
  const rejected = assert.rejects(first, { code: 'CODEX_REQUEST_ABORTED' });
  while (!fixture.children.length) await delay(1);
  cancellation.abort(); await rejected;
  const surviving = await second;
  try {
    assert.equal(fixture.launches.length, 1);
    assert.equal(surviving.peers(), 1);
    assert.equal(surviving.isClosed(), false);
    const start = await surviving.request('thread/start', {});
    assert.equal(start.thread.id, 'thread-1');
  } finally { await surviving.close(); }
});

test('thread routing is exact and retiring an unsafe owner preserves its healthy peer', async () => {
  const fixture = fakeCodexServer();
  const received = [];
  const first = await acquireCodexServer(options(fixture, { onNotification: (method) => received.push(`first:${method}`) }));
  const second = await acquireCodexServer(options(fixture, { onNotification: (method) => received.push(`second:${method}`) }));
  const firstThread = (await first.request('thread/start', {})).thread.id;
  const secondThread = (await second.request('thread/start', {})).thread.id;
  try {
    await assert.rejects(first.request('turn/start', { threadId: secondThread }), { writeOutcome: 'not-written' });
    fixture.children[0].stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: firstThread } }) + '\n');
    fixture.children[0].stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: secondThread } }) + '\n');
    assert.deepEqual(received, ['first:turn/started', 'second:turn/started']);
    await first.retireThread();
    await first.close();
    fixture.children[0].stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: firstThread } }) + '\n');
    fixture.children[0].stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: secondThread } }) + '\n');
    assert.equal(received.at(-1), 'second:turn/completed');
    assert.equal(received.filter((value) => value === 'first:turn/completed').length, 0);
    assert.equal(second.isClosed(), false);
    assert.equal(fixture.children[0].exitCode, null);
    assert.equal(fixture.requests.filter((request) => request.method === 'thread/unsubscribe' && request.params.threadId === firstThread).length, 1);
  } finally { await first.close(); await second.close(); }
});

test('late thread/start replies are surfaced and orphan threads are unsubscribed', async () => {
  const fixture = fakeCodexServer();
  const late = [];
  const owner = await acquireCodexServer(options(fixture, { spawnImpl: delayedResponses(fixture, 'thread/start', 25), onLateResponse: (response) => late.push(response) }));
  try {
    await assert.rejects(owner.request('thread/start', {}, 5), { code: 'CODEX_REQUEST_TIMEOUT' });
    await delay(40);
    assert.equal(late[0].result.thread.id, 'thread-1');
    assert.equal(fixture.requests.filter((request) => request.method === 'thread/start').length, 1);
    assert.ok(fixture.requests.some((request) => request.method === 'thread/unsubscribe' && request.params.threadId === 'thread-1'));
  } finally { await owner.close(); }
});

test('late turn/start identity is surfaced before exact orphan interruption and never replayed', async () => {
  const fixture = fakeCodexServer({ hang: true });
  const chronology = [];
  const owner = await acquireCodexServer(options(fixture, {
    spawnImpl: delayedResponses(fixture, 'turn/start', 25),
    onLateResponse: (response) => chronology.push(`late:${response.result.turn.id}`),
    onNotification: (method, params) => { if (method === 'turn/completed') chronology.push(`stopped:${params.turn.id}`); },
  }));
  try {
    const threadId = (await owner.request('thread/start', {})).thread.id;
    await assert.rejects(owner.request('turn/start', { threadId }, 5), { code: 'CODEX_REQUEST_TIMEOUT' });
    await delay(40);
    assert.deepEqual(chronology, ['late:turn-1', 'stopped:turn-1']);
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/start').length, 1);
    assert.equal(fixture.requests.filter((request) => request.method === 'turn/interrupt').length, 1);
  } finally { await owner.close(); }
});

test('workers with different authentication environments are never pooled together', async () => {
  const fixture = fakeCodexServer();
  const first = await acquireCodexServer(options(fixture, { env: { CODEX_HOME: '/fixture/one' } }));
  const second = await acquireCodexServer(options(fixture, { env: { CODEX_HOME: '/fixture/two' } }));
  try { assert.equal(fixture.launches.length, 2); }
  finally { await first.close(); await second.close(); }
});
