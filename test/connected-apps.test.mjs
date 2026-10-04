import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectedApps, isAllowedAppTool } from '../src/proactive/connected-apps.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';

const readOnly = { readOnlyHint: true, destructiveHint: false };

function fakeServer({ tools = {}, toolsError = null, callResult = { content: [{ type: 'text', text: 'inbox summary' }] }, pendingPolls = 0 } = {}) {
  const requests = [];
  let polls = 0;
  const server = {
    closed: false,
    isClosed: () => server.closed,
    close: async () => { server.closed = true; },
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'config/read') return { config: { mcp_servers: { blender: {}, discord: {} } } };
      if (method === 'thread/start') return { thread: { id: 'apps-thread', ephemeral: true } };
      if (method === 'mcpServerStatus/list') {
        polls += 1;
        if (polls <= pendingPolls) return { data: [{ name: 'codex_apps', runtimeStatus: 'starting', tools: {} }] };
        return { data: [{ name: 'codex_apps', runtimeStatus: 'connected', tools, toolsError }, { name: 'blender', tools: { run: { annotations: readOnly } } }] };
      }
      if (method === 'mcpServer/tool/call') return callResult;
      throw new Error(`unexpected ${method}`);
    },
  };
  return { server, requests, acquire: async () => server };
}

const catalog = {
  'gmail.search_emails': { title: 'Search', description: 'Search email', annotations: readOnly, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  'gmail.delete_emails': { annotations: { readOnlyHint: false, destructiveHint: true } },
  'gmail.create_draft': { annotations: { readOnlyHint: false, destructiveHint: false } },
  'google_drive.search': { description: 'Find files', annotations: readOnly },
  'paypal.list_transactions': { annotations: readOnly },
  'github.list_payment_methods': { annotations: readOnly },
  'linear.unannotated': {},
};

test('only read-only, non-destructive, non-payment app tools are allowed', () => {
  assert.equal(isAllowedAppTool('gmail.search_emails', readOnly), true);
  assert.equal(isAllowedAppTool('google_drive.get_document_paragraph_range', readOnly), true);
  assert.equal(isAllowedAppTool('gmail.create_draft', { readOnlyHint: false }), false);
  assert.equal(isAllowedAppTool('gmail.read_email', { readOnlyHint: true, destructiveHint: true }), false);
  assert.equal(isAllowedAppTool('linear.search', undefined), false);
  assert.equal(isAllowedAppTool('paypal.list_transactions', readOnly), false);
  assert.equal(isAllowedAppTool('sites.list_invoices', readOnly), false);
  assert.equal(isAllowedAppTool('figma.display_frames', readOnly), true, 'segment matching must not block words that merely contain "pay"');
  assert.equal(isAllowedAppTool('not a tool', readOnly), false);
});

test('connected apps load on a locked-down hidden thread and expose only allowed tools', async () => {
  const { requests, acquire } = fakeServer({ tools: catalog, pendingPolls: 2 });
  const apps = createConnectedApps({ command: 'codex', acquire, sleep: async () => {} });
  const listed = await apps.list();
  assert.deepEqual(listed.apps, { gmail: 1, google_drive: 1 });
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['gmail.search_emails', 'google_drive.search']);
  assert.deepEqual((await apps.list({ app: 'google_drive' })).tools.map((tool) => tool.name), ['google_drive.search']);
  assert.deepEqual((await apps.list({ query: 'search email' })).tools.map((tool) => tool.name), ['gmail.search_emails']);

  const start = requests.find((request) => request.method === 'thread/start').params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.approvalPolicy, 'never');
  assert.deepEqual(start.dynamicTools, []);
  assert.equal(start.config.features.apps, true);
  assert.equal(start.config.features.shell_tool, false);
  assert.deepEqual(start.config.mcp_servers, { blender: { enabled: false }, discord: { enabled: false } });
  assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1, 'the catalog is cached');
  await apps.close();
});

test('calls are refused unless allowed, and results are shaped as untrusted private data', async () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const { requests, acquire } = fakeServer({ tools: catalog, callResult: { content: [{ type: 'text', text: 'x'.repeat(30) }, image], structuredContent: { count: 1 }, isError: false } });
  const apps = createConnectedApps({ acquire, maxTextLength: 10 });
  for (const tool of ['gmail.delete_emails', 'gmail.create_draft', 'paypal.list_transactions', 'blender.run']) {
    await assert.rejects(() => apps.call({ tool, arguments: {} }), /not an approved read-only/);
  }
  assert.equal(requests.filter((request) => request.method === 'mcpServer/tool/call').length, 0);

  const result = await apps.call({ tool: 'gmail.search_emails', arguments: { query: 'invoice from bob' } });
  assert.deepEqual(requests.at(-1), { method: 'mcpServer/tool/call', params: { server: 'codex_apps', threadId: 'apps-thread', tool: 'gmail.search_emails', arguments: { query: 'invoice from bob' } } });
  assert.equal(result.text, 'x'.repeat(10));
  assert.equal(result.truncated, true);
  assert.deepEqual(result.structuredContent, { count: 1 });
  assert.deepEqual(result.toolImages, [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
  assert.equal(result.untrustedContent, true);
  assert.equal(result.privateOwnerData, true);
  await apps.close();
  await assert.rejects(() => apps.list(), /stopped/);
});

test('catalog errors surface clearly', async () => {
  const { acquire } = fakeServer({ tools: {}, toolsError: 'upstream 500' });
  await assert.rejects(() => createConnectedApps({ acquire }).list(), /Connected apps are unavailable: upstream 500/);
});

test('app tools exist only in the owner DM worker and block web links for the rest of that answer', async () => {
  const calls = [];
  const connectedApps = { list: async (args) => { calls.push(['list', args]); return { tools: [] }; }, call: async (args) => { calls.push(['call', args]); return { text: 'secret', untrustedContent: true }; } };
  const web = { lookupImpl: async () => { throw new Error('lookup stub'); } };
  const service = { accounts: [] };
  const names = (tools) => tools.definitions.map((definition) => definition.name);

  assert.ok(!names(createDiscordReadTools(service, { channelId: '200000000000000001', guildId: '100000000000000001', directMessages: false }, { connectedApps, web })).includes('apps_call_tool'));
  assert.ok(!names(createDiscordReadTools(service, { trustedLocal: true, directMessages: true }, { connectedApps, web })).includes('apps_call_tool'));
  assert.ok(!names(createDiscordReadTools(service, { channelId: '200000000000000004', guildId: null, directMessages: true }, { web })).includes('apps_call_tool'));

  const tools = createDiscordReadTools(service, { channelId: '200000000000000004', guildId: null, directMessages: true }, { connectedApps, web });
  assert.ok(names(tools).includes('apps_list_tools') && names(tools).includes('apps_call_tool'));
  await assert.rejects(() => tools.call('web_read_link', { url: 'https://example.com/' }), /lookup stub/);
  await tools.call('apps_list_tools', { app: 'gmail' });
  await assert.rejects(() => tools.call('web_read_link', { url: 'https://example.com/' }), /lookup stub/, 'listing tools reads no private data');
  const result = JSON.parse((await tools.call('apps_call_tool', { tool: 'gmail.search_emails', arguments: { query: 'hi' } })).contentItems[0].text);
  assert.equal(result.text, 'secret');
  await assert.rejects(() => tools.call('web_read_link', { url: 'https://example.com/?leak=secret' }), /unavailable for the rest of this answer/);
  tools.beginTurn();
  await assert.rejects(() => tools.call('web_read_link', { url: 'https://example.com/' }), /lookup stub/);
  assert.deepEqual(calls, [['list', { app: 'gmail', limit: 40 }], ['call', { tool: 'gmail.search_emails', arguments: { query: 'hi' } }]]);
});
