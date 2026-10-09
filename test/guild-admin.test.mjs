import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DiscordService } from '../src/service.mjs';
import { createDiscordMcpServer } from '../src/server.mjs';
import { addMemberRole, createCategory, createChannel, createRole, normalizeRoleColor, removeMemberRole } from '../src/guild-admin.mjs';

const guildId = '100000000000000001';
const categoryId = '200000000000000001';
const userId = '300000000000000001';
const roleId = '400000000000000001';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixture({ failWith } = {}) {
  const requests = [];
  const service = new DiscordService({
    accounts: [{ id: 'admin', token: 'mock-token' }],
    sleep: async () => {},
    fetchImpl: async (input, options) => {
      const path = new URL(input).pathname.replace('/api/v10', '');
      const payload = options.body ? JSON.parse(options.body) : null;
      const write = options.method !== 'GET';
      if (write) requests.push({ path, method: options.method, payload, headers: options.headers });
      if (path === '/users/@me') return json({ id: '500000000000000001', username: 'Nova', bot: true });
      if (path === '/users/@me/guilds') return json([{ id: guildId, name: 'Example' }]);
      if (path === `/guilds/${guildId}`) return json({ id: guildId, name: 'Example' });
      if (write && failWith) return failWith();
      if (path === `/guilds/${guildId}/channels`) return json({ id: '600000000000000001', guild_id: guildId, name: payload.name, type: payload.type, parent_id: payload.parent_id, topic: payload.topic });
      if (path === `/guilds/${guildId}/roles`) return json({ id: roleId, name: payload.name, color: payload.color, hoist: payload.hoist, mentionable: false, managed: false, position: 1, permissions: payload.permissions ?? '1071698660929' });
      if (path.startsWith(`/guilds/${guildId}/members/${userId}/roles/`)) return new Response(null, { status: 204 });
      throw new Error(`Unexpected route: ${options.method} ${path}`);
    },
  });

  return { service, requests };
}

test('creates a category and then a channel inside it with an audit log reason', async () => {
  const { service, requests } = fixture();
  const category = await createCategory(service, { guildId, name: 'Projects', reason: 'requested by owner' });
  assert.equal(category.channel.typeName, 'GUILD_CATEGORY');
  assert.deepEqual(requests[0].payload, { name: 'Projects', type: 4 });
  assert.equal(requests[0].headers['X-Audit-Log-Reason'], 'requested%20by%20owner');

  const channel = await createChannel(service, { guildId, name: 'build-log', type: 'voice', parentId: categoryId, userLimit: 5 });
  assert.equal(channel.channel.typeName, 'GUILD_VOICE');
  assert.equal(channel.channel.parentId, categoryId);
  assert.deepEqual(requests[1].payload, { name: 'build-log', type: 2, parent_id: categoryId, user_limit: 5 });
  assert.equal(requests[1].headers['X-Audit-Log-Reason'], undefined);
});

test('creates a role with a hex color and refuses malformed permission bitfields', async () => {
  const { service, requests } = fixture();
  const result = await createRole(service, { guildId, name: 'Builders', color: '#ff8800', hoist: true, permissions: '0' });
  assert.equal(result.role.id, roleId);
  assert.deepEqual(requests[0].payload, { name: 'Builders', color: 0xff8800, hoist: true, permissions: '0' });
  assert.equal(normalizeRoleColor('00ff00'), 0x00ff00);
  for (const color of [-1, 0x1000000, 'red', 1.5]) assert.throws(() => normalizeRoleColor(color), /color must be/);
  await assert.rejects(() => createRole(service, { guildId, name: 'Bad', permissions: '8; DROP' }), /permission bitfield/);
  assert.equal(requests.length, 1);
});

test('gives and takes away roles with idempotent PUT and DELETE, and refuses @everyone', async () => {
  const { service, requests } = fixture();
  assert.deepEqual(await addMemberRole(service, { guildId, userId, roleId }), { accountId: 'admin', guildId, userId, roleId, assigned: true });
  assert.deepEqual(await removeMemberRole(service, { guildId, userId, roleId }), { accountId: 'admin', guildId, userId, roleId, removed: true });
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), [`PUT /guilds/${guildId}/members/${userId}/roles/${roleId}`, `DELETE /guilds/${guildId}/members/${userId}/roles/${roleId}`]);
  await assert.rejects(() => addMemberRole(service, { guildId, userId, roleId: guildId }), /@everyone/);
  await assert.rejects(() => removeMemberRole(service, { guildId, userId: 'nope', roleId }), /userId/);
});

test('validates inputs before any request and honours cancellation', async () => {
  const { service, requests } = fixture();
  await assert.rejects(() => createChannel(service, { guildId, name: '' }), /name must be/);
  await assert.rejects(() => createChannel(service, { guildId, name: 'x', type: 'thread' }), /type must be/);
  await assert.rejects(() => createChannel(service, { guildId, name: 'x', userLimit: 100 }), /userLimit/);
  await assert.rejects(() => createChannel(service, { guildId: 'abc', name: 'x' }), /guildId/);
  await assert.rejects(() => createCategory(service, { guildId, name: 'x'.repeat(101) }), /name must be/);
  await assert.rejects(() => createRole(service, { guildId, name: 'x', reason: 'r'.repeat(513) }), /reason/);
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(() => createCategory(service, { guildId, name: 'x' }, { signal: cancellation.signal }), /abort/i);
  assert.equal(requests.length, 0);
});

test('creates are not retried: a rejection is reported plainly and a server failure warns the outcome is unknown', async () => {
  for (const [status, unknown] of [[403, false], [500, true]]) {
    const { service, requests } = fixture({ failWith: () => json({ message: 'Missing Permissions' }, status) });
    await assert.rejects(() => createChannel(service, { guildId, name: 'general' }), (error) => {
      assert.equal(error.sendStatus, unknown ? 'unknown' : 'rejected');
      assert.equal(/may have been created/.test(error.message), unknown);
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test('MCP exposes the five administration tools as non-read-only writes', async () => {
  const { service, requests } = fixture();
  const server = createDiscordMcpServer(service);
  const client = new Client({ name: 'guild-admin-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const names = ['discord_create_channel', 'discord_create_category', 'discord_create_role', 'discord_add_role', 'discord_remove_role'];
    for (const name of names) assert.equal(tools.find((tool) => tool.name === name)?.annotations.readOnlyHint, false, name);
    const created = await client.callTool({ name: 'discord_create_channel', arguments: { guildId, name: 'announcements', type: 'announcement' } });
    assert.equal(created.structuredContent.channel.typeName, 'GUILD_ANNOUNCEMENT');
    const given = await client.callTool({ name: 'discord_add_role', arguments: { guildId, userId, roleId } });
    assert.equal(given.structuredContent.assigned, true);
    const refused = await client.callTool({ name: 'discord_create_channel', arguments: { guildId, name: 'x', type: 'thread' } });
    assert.equal(refused.isError, true);
    assert.equal(requests.length, 2);
  } finally { await client.close(); await server.close(); }
});
