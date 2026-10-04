import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Client, Events } from 'discord.js';
import { createGateway } from '../src/proactive/gateway.mjs';
import { destroyGatewaySockets } from '../src/proactive/gateway-strategy.mjs';

test('teardown protects and terminates a connecting socket after the SDK removes its error handler', async () => {
  const socket = new EventEmitter();
  socket.readyState = 0;
  socket.terminate = () => { socket.readyState = 3; socket.emit('error', new Error('Opening handshake has timed out')); };
  const errors = [];
  const strategy = { shards: new Map([[0, { connection: socket }]]) };
  await destroyGatewaySockets(strategy, async () => { socket.onerror = null; }, {}, (error) => errors.push(error.message));
  assert.deepEqual(errors, ['Opening handshake has timed out']);
  assert.equal(socket.readyState, 3);
});

function fakeClient(login) {
  const client = new EventEmitter();
  client.user = { id: '300000000000000001', username: 'Nova' };
  client.guilds = { cache: new Map() };
  client.login = () => login(client);
  client.destroyed = 0;
  client.destroy = async () => { client.destroyed += 1; };
  return client;
}

test('a shard handshake failure retries with a fresh client and resumes connection status', async () => {
  const clients = [];
  const delays = [];
  const errors = [];
  const gateway = createGateway({ token: 'fixture', onError: (error) => errors.push(error.message), sleep: async (delay) => delays.push(delay),
    clientFactory: () => {
      const client = fakeClient((current) => {
        if (clients.length === 1) queueMicrotask(() => current.emit(Events.ShardError, new Error('Opening handshake has timed out')));
        else queueMicrotask(() => current.emit(Events.ClientReady));
        return Promise.resolve();
      });
      clients.push(client); return client;
    },
  });
  try {
    const first = gateway.connect();
    assert.equal(first, gateway.connect());
    assert.equal((await first).username, 'Nova');
    assert.equal(clients.length, 2);
    assert.equal(clients[0].destroyed, 1);
    assert.deepEqual(delays, [1000]);
    assert.ok(errors.includes('Opening handshake has timed out'));
    clients[1].emit(Events.ShardDisconnect);
    assert.equal(gateway.status().connected, false);
    clients[1].emit(Events.ShardResume);
    assert.equal(gateway.status().connected, true);
    assert.equal(gateway.status().reconnects, 1);
  } finally { await gateway.close(); }
});

test('closing during login settles readiness immediately and prevents retries or double destruction', async () => {
  const client = fakeClient(() => new Promise(() => {}));
  const gateway = createGateway({ clientFactory: () => client, readyTimeoutMs: 10000 });
  const ready = gateway.connect();
  const rejected = assert.rejects(ready, /stopped/);
  await Promise.resolve();
  const closing = gateway.close();
  assert.equal(closing, gateway.close());
  await Promise.all([closing, rejected]);
  assert.equal(client.destroyed, 1);
  assert.equal(gateway.status().connectionAttempts, 1);
});

test('authentication failures stop without retrying and rejected destroy promises stay handled', async () => {
  let created = 0;
  const errors = [];
  const gateway = createGateway({ onError: (error) => errors.push(error.message), clientFactory: () => {
    created += 1;
    const client = fakeClient(async () => { throw new Error('An invalid token was provided'); });
    client.destroy = async () => { throw new Error('Teardown failed'); };
    return client;
  } });
  await assert.rejects(gateway.connect(), /invalid token/);
  await gateway.close();
  assert.equal(created, 1);
  assert.deepEqual(errors, ['Teardown failed']);
});

test('actual Discord SDK pending HTTP upgrades can time out and retry without an unhandled WebSocket error', async () => {
  const sockets = new Set();
  const server = createServer();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let created = 0;
  const errors = [];
  const gateway = createGateway({ token: 'fixture-token', readyTimeoutMs: 50, maxAttempts: 2, sleep: async () => {}, onError: (error) => errors.push(error.message),
    clientFactory: (options) => {
      created += 1;
      const client = new Client({ ...options, shards: [0], shardCount: 1 });
      client.rest.get = async () => ({ url: `ws://127.0.0.1:${server.address().port}`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } });
      return client;
    },
  });
  try {
    await assert.rejects(gateway.connect(), /readiness timed out/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created, 2);
    assert.ok(errors.some((message) => /before the connection was established/.test(message)));
  } finally {
    await gateway.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
