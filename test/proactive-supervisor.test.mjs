import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { isFatalListenerFailure, listenerControlAddress, runSupervisor } from '../src/proactive/supervisor.mjs';

function fixture({ outcomes = [{ code: 0 }], enabled = true, onSleep, controlUrl, status = {}, controlStatus, ignoreTermination = false } = {}) {
  const configurationPath = '/private/listener.json';
  const sidecarPath = `${configurationPath}.supervision.json`;
  const statusPath = '/private/listener.status.json';
  const files = new Map([[configurationPath, { listenerId: 'fixture', accountId: 'default', allServers: true, ...(controlUrl ? { controlUrl, controlToken: 'private-token' } : {}) }], [sidecarPath, { enabled }], [statusPath, status]]);
  const launches = [];
  const signals = [];
  const fetches = [];
  let currentTime = 0;
  const options = { childEntrypoint: '/private/daemon.mjs', configurationPath, pid: 123,
    initialBackoffMs: 10, maxBackoffMs: 40, pollMs: 5, terminationGraceMs: 5, disconnectedTimeoutMs: 20,
    read: async (path) => files.get(path) || null, write: async (path, value) => { files.set(path, structuredClone(value)); }, now: () => currentTime,
    sleep: async (milliseconds) => { currentTime += milliseconds; await onSleep?.({ milliseconds, files, sidecarPath, launches }); await Promise.resolve(); },
    spawnImpl: (command, args, configuration) => {
      launches.push({ command, args, configuration });
      const child = new EventEmitter();
      child.kill = (signal) => { signals.push(signal); if (!ignoreTermination || signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal)); };
      const outcome = outcomes[Math.min(launches.length - 1, outcomes.length - 1)];
      if (outcome) queueMicrotask(() => {
        if (outcome.error) child.emit('error', new Error('sensitive startup failure'));
        else { if (outcome.status) files.set(statusPath, outcome.status); child.emit('close', outcome.code, outcome.signal); }
      });
      return child;
    },
    fetchImpl: async (url, options) => { fetches.push({ url: String(url), options }); return { ok: true, json: async () => ({ listenerId: 'fixture', state: 'running', gateway: { connected: false }, ...controlStatus }) }; },
  };
  return { options, files, launches, signals, fetches, sidecarPath, statusPath };
}

test('normal exit stops supervision without restarting or exposing private control credentials', async () => {
  const example = fixture();
  const result = await runSupervisor(example.options);
  assert.equal(result.state, 'stopped');
  assert.equal(example.launches.length, 1);
  const sidecar = example.files.get(example.sidecarPath);
  assert.equal(sidecar.enabled, false);
  assert.equal(sidecar.pid, 123);
  assert.equal('accountId' in sidecar, false);
  assert.equal(example.files.get(example.statusPath).state, 'stopped');
});

test('transient crashes recover with bounded backoff and stop at the restart cap', async () => {
  const example = fixture({ outcomes: [{ code: 1, status: { lastError: 'Opening handshake has timed out' } }] });
  const result = await runSupervisor({ ...example.options, maxRestarts: 2 });
  assert.deepEqual(result, { state: 'failed', restarts: 2 });
  assert.equal(example.launches.length, 3);
  assert.match(example.files.get(example.statusPath).lastError, /restart limit/);
});

test('invalid tokens and disallowed intents require attention instead of retrying', async () => {
  for (const lastError of ['Invalid bot token', 'Disallowed intents 4014', 'Unauthorized', 'Codex is not logged in']) {
    const example = fixture({ outcomes: [{ code: 1, status: { lastError } }] });
    const result = await runSupervisor(example.options);
    assert.equal(result.state, 'failed');
    assert.equal(example.launches.length, 1);
    assert.match(example.files.get(example.statusPath).lastError, /authentication or Discord intents/);
  }
  assert.equal(isFatalListenerFailure('temporary network failure'), false);
});

test('owner disabling supervision during backoff prevents the next launch', async () => {
  const example = fixture({ outcomes: [{ code: 1 }], onSleep: ({ files, sidecarPath }) => { files.set(sidecarPath, { ...files.get(sidecarPath), enabled: false }); } });
  const result = await runSupervisor(example.options);
  assert.equal(result.state, 'stopped');
  assert.equal(example.launches.length, 1);
});

test('owner stop terminates an active child and bounded force kills an unresponsive child', async () => {
  const example = fixture({ outcomes: [null], ignoreTermination: true, onSleep: ({ files, sidecarPath }) => { files.set(sidecarPath, { ...files.get(sidecarPath), enabled: false }); } });
  const result = await runSupervisor(example.options);
  assert.equal(result.state, 'stopped');
  assert.deepEqual(example.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(example.launches.length, 1);
});

test('a stalled connected listener is checked only through the validated local control endpoint', async () => {
  const example = fixture({ outcomes: [null], controlUrl: 'http://127.0.0.1:54321' });
  const result = await runSupervisor({ ...example.options, maxRestarts: 0 });
  assert.equal(result.state, 'failed');
  assert.deepEqual(example.signals, ['SIGTERM']);
  assert.ok(example.fetches.length >= 2);
  assert.equal(example.fetches[0].url, 'http://127.0.0.1:54321/status');
  assert.equal(example.fetches[0].options.redirect, 'error');
  assert.equal(example.fetches[0].options.headers.Authorization, 'Bearer private-token');
  assert.equal(JSON.stringify([...example.files.values()]).includes('private-token'), true);
  assert.equal(JSON.stringify(example.files.get(example.sidecarPath)).includes('private-token'), false);
});

test('arbitrary URLs and redirected credentials are never accepted as listener control endpoints', () => {
  for (const controlUrl of ['https://127.0.0.1:123', 'http://localhost:123', 'http://example.com:123', 'http://127.0.0.1:123/path', 'http://user:password@127.0.0.1:123', 'http://127.0.0.1:123?redirect=x']) {
    assert.equal(listenerControlAddress({ controlUrl, controlToken: 'private' }), null);
  }
});

test('disabled sidecars never spawn a daemon', async () => {
  const example = fixture({ enabled: false });
  assert.deepEqual(await runSupervisor(example.options), { state: 'stopped', restarts: 0 });
  assert.equal(example.launches.length, 0);
});
