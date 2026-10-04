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

test('routes discord_browse_messages through the shared browser', async () => {
  const guildId = '100000000000000001';
  const channelId = '200000000000000001';
  const author = { id: '400000000000000001', username: 'reader' };
  const history = [{ id: '300000000000000002', content: 'newer', author }, { id: '300000000000000001', content: 'older', author }];
  const service = {
    normalizeReadSource: ({ channelId: id }) => ({ guildId: null, channelId: id, messageId: null, url: null }),
    resolveChannel: async () => ({ account: { id: 'reader', client: { listMessages: async () => history } }, channel: { id: channelId, guild_id: guildId, type: 0 } }),
  };
  const server = createDiscordMcpServer(service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'discord_browse_messages', arguments: { channelId, limit: 10 } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.messages.map((message) => message.content), ['older', 'newer']);
    assert.deepEqual(result.structuredContent.cursors, { oldest: history[1].id, newest: history[0].id });
    assert.equal('toolImages' in result.structuredContent, false);
  } finally {
    await client.close();
    await server.close();
  }
});
