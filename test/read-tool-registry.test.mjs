import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDiscordMcpServer } from '../src/server.mjs';
import { readToolFields } from '../src/proactive/read-tool-registry.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { z } from 'zod/v4';

test('MCP derives shared read schemas while preserving trusted optional filters and all existing tool names', async () => {
  const service = { accounts: [], listServers: async () => ({ servers: [], accounts: [] }) };
  const server = createDiscordMcpServer(service);
  const client = new Client({ name: 'registry-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 35); assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const name of ['discord_read', 'discord_send_message', 'discord_read_messages', 'discord_find_members', 'web_read_link', 'discord_research_topic', 'read_tool_result']) assert.ok(tools.some((tool) => tool.name === name), name);
    const search = tools.find((tool) => tool.name === 'discord_search_messages');
    for (const field of ['accountId', 'repliedToMessageIds', 'embedTypes', 'has', 'includeNsfw', 'sortBy']) assert.ok(search.inputSchema.properties[field], field);
    assert.equal(search.inputSchema.properties.limit.default, 250);
    assert.deepEqual(search.inputSchema.properties, z.toJSONSchema(z.object(readToolFields('discord_search_messages', { trustedLocal: true })), { io: 'input' }).properties);
    const result = await client.callTool({ name: 'discord_list_servers', arguments: {} }); assert.equal(result.isError, undefined);
  } finally { await client.close(); await server.close(); }
});

test('worker derives filtered shared schemas and never accepts trusted account selection or optional public user lookup', () => {
  const tools = createDiscordReadTools({ accounts: [] }, { directMessages: true, channelId: '200000000000000001' });
  const search = tools.registry.find((tool) => tool.name === 'discord_search_messages');
  assert.equal(search.schema.shape.accountId, undefined);
  assert.equal(search.schema.shape.repliedToMessageIds, undefined);
  assert.equal(search.schema.parse({ guildId: '100000000000000001' }).limit, 50);
  assert.throws(() => tools.registry.find((tool) => tool.name === 'discord_user_info').schema.parse({ userId: '300000000000000001' }));
});
