import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordApiClient } from '../src/discord-api.mjs';
import { DiscordService } from '../src/service.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDiscordMcpServer } from '../src/server.mjs';

function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function connectionFailure(code) {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('Network failure'), { code }) });
}

test('read requests recover from a temporary connection failure', async () => {
  let requests = 0;
  const waits = [];
  const client = new DiscordApiClient({
    token: 'mock-token', accountId: 'reader',
    sleep: async (delay) => { waits.push(delay); },
    fetchImpl: async () => {
      if (++requests === 1) throw connectionFailure('ECONNRESET');
      return json({ ok: true });
    },
  });

  assert.deepEqual(await client.get('/test'), { ok: true });
  assert.equal(requests, 2);
  assert.deepEqual(waits, [250]);
});

test('persistent DNS failures are bounded and report the underlying cause', async () => {
  let requests = 0;
  const client = new DiscordApiClient({
    token: 'mock-token', accountId: 'reader', maxRetries: 2,
    sleep: async () => {},
    fetchImpl: async () => { requests += 1; throw connectionFailure('ENOTFOUND'); },
  });

  await assert.rejects(() => client.get('/test'), (error) => {
    assert.equal(error.code, 'ENOTFOUND');
    assert.equal(error.accountId, 'reader');
    assert.match(error.message, /DNS/);
    assert.ok(!error.message.includes('mock-token'));
    return true;
  });
  assert.equal(requests, 3);
});

test('permission and certificate failures fail immediately instead of retrying', async () => {
  for (const code of ['EPERM', 'EACCES', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    let requests = 0;
    const client = new DiscordApiClient({
      token: 'mock-token',
      fetchImpl: async () => { requests += 1; throw connectionFailure(code); },
    });
    await assert.rejects(() => client.get('/test'), (error) => error.code === code);
    assert.equal(requests, 1);
  }
});

test('network failures never retry a message send', async () => {
  let requests = 0;
  const client = new DiscordApiClient({
    token: 'mock-token',
    fetchImpl: async () => { requests += 1; throw connectionFailure('ECONNRESET'); },
  });
  await assert.rejects(() => client.sendMessage('200000000000000001', { content: 'Hello' }), (error) => error.code === 'ECONNRESET');
  assert.equal(requests, 1);
});

test('failed discovery is not cached as an empty server list', async () => {
  let available = false;
  let requests = 0;
  const service = new DiscordService({
    accounts: [{ id: 'reader', token: 'mock-token' }], maxRetries: 0,
    fetchImpl: async (input) => {
      requests += 1;
      if (!available) throw connectionFailure('ENOTFOUND');
      return json(new URL(input).pathname.endsWith('/guilds')
        ? [{ id: '100000000000000001', name: 'Example' }]
        : { id: '500000000000000001', username: 'Nova' });
    },
  });
  const failed = await service.listServers();
  assert.equal(failed.servers.length, 0);
  assert.ok(failed.accounts[0].error);

  available = true;
  const recovered = await service.listServers();
  assert.equal(recovered.servers.length, 1);
  assert.equal(recovered.accounts[0].error, null);
  assert.equal(requests, 4);
  await service.listServers();
  assert.equal(requests, 4);
});

test('partial discovery failures do not permanently hide a recovered bot', async () => {
  let secondaryAvailable = false;
  const service = new DiscordService({
    accounts: [{ id: 'primary', token: 'primary' }, { id: 'secondary', token: 'secondary' }], maxRetries: 0,
    fetchImpl: async (input, options) => {
      const secondary = options.headers.Authorization === 'Bot secondary';
      if (secondary && !secondaryAvailable) throw connectionFailure('ECONNREFUSED');
      return json(new URL(input).pathname.endsWith('/guilds')
        ? [{ id: secondary ? '100000000000000002' : '100000000000000001', name: secondary ? 'Secondary' : 'Primary' }]
        : { id: secondary ? '500000000000000002' : '500000000000000001', username: 'Nova' });
    },
  });
  assert.equal((await service.listServers()).servers.length, 1);
  secondaryAvailable = true;
  assert.equal((await service.listServers()).servers.length, 2);
});

test('MCP discovery reports a connection failure as a tool error instead of successful empty discovery', async () => {
  const service = new DiscordService({
    accounts: [{ id: 'reader', token: 'mock-token' }], maxRetries: 0,
    fetchImpl: async () => { throw connectionFailure('ENOTFOUND'); },
  });
  const server = createDiscordMcpServer(service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'discord_list_servers', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.accounts[0].error.code, 'ENOTFOUND');
  } finally {
    await client.close();
    await server.close();
  }
});
