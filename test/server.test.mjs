import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDiscordMcpServer } from '../src/server.mjs';

test('returns compact JSON without changing structured MCP results', async () => {
  const payload = { servers: [{ id: '100000000000000001', name: 'Example server', accounts: ['reader'] }], accounts: [] };
  const server = createDiscordMcpServer({ listServers: async () => payload });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'discord_list_servers', arguments: {} });
    assert.deepEqual(result.structuredContent, payload);
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
    assert.equal(result.content[0].text, JSON.stringify(payload));
    assert.ok(result.content[0].text.length < JSON.stringify(payload, null, 2).length);
  } finally {
    await client.close();
    await server.close();
  }
});
