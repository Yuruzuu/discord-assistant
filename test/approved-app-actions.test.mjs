import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectedApps, isAllowedAppAction } from '../src/proactive/connected-apps.mjs';
import { createOwnerCapabilities } from '../src/proactive/owner-capabilities.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const channelId = '200000000000000004';
const actionTool = { annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } } } };
function fixture() {
  const calls = []; let schema = actionTool;
  const server = { close: async () => {}, isClosed: () => false, request: async (method, args) => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'apps', ephemeral: true } };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_apps', tools: { 'github.create_issue': schema, 'stripe.create_payment': actionTool, 'github.unknown': { inputSchema: {} } } }] };
    if (method === 'mcpServer/tool/call') { calls.push(args); return { content: [{ type: 'text', text: 'issue created' }] }; }
    throw new Error(method);
  } };
  const apps = createConnectedApps({ acquire: async () => server });
  return { apps, calls, change: (value) => { schema = value; } };
}

test('write catalog and exact argument validation never enable ordinary app calls or payment actions', async () => {
  const { apps, calls } = fixture();
  try {
    assert.equal(isAllowedAppAction('github.create_issue', actionTool.annotations), true);
    assert.equal(isAllowedAppAction('stripe.create_payment', actionTool.annotations), false);
    assert.equal(isAllowedAppAction('github.unknown', {}), false);
    assert.equal((await apps.list()).tools.length, 0);
    assert.deepEqual((await apps.list({ access: 'action' })).tools.map((tool) => tool.name), ['github.create_issue']);
    await assert.rejects(apps.call({ tool: 'github.create_issue', arguments: { title: 'Issue' } }), /read-only/);
    await assert.rejects(apps.validateAction({ tool: 'github.create_issue', arguments: {} }), /schema/);
    await assert.rejects(apps.validateAction({ tool: 'github.create_issue', arguments: { title: 'Issue', surprise: true } }), /schema/);
    assert.equal(calls.length, 0);
  } finally { await apps.close(); }
});

test('owner DM proposal has exact preview and requires independent approval before a single app execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-app-actions-'));
  const { apps, calls } = fixture(); const sends = [];
  const service = { accounts: [], accountById: () => ({ client: { sendMessage: async (_, payload) => { sends.push(payload); return { id: '100000000000000001' }; } } }) };
  let capabilities;
  try {
    capabilities = await createOwnerCapabilities({ service, accountId: 'default', channelId, settings: { reminders: false, handoffs: false }, connectedApps: apps, root, actionComponents: (choices) => choices });
    const tools = createDiscordReadTools(service, { channelId, directMessages: true }, { connectedApps: apps, ownerActions: capabilities.actions });
    const result = await tools.call('apps_prepare_action', { tool: 'github.create_issue', arguments: { title: 'Exact owner-selected issue' }, title: 'Create GitHub issue' });
    const proposal = JSON.parse(result.contentItems[0].text);
    assert.equal(calls.length, 0);
    assert.match(sends[0].content, /Exact owner-selected issue/);
    assert.deepEqual(sends[0].allowed_mentions, { parse: [] });
    const response = await capabilities.control({ action: 'approval', id: proposal.id, decision: 'approve', userId: directMessageOwnerId, channelId });
    assert.equal(response.state, 'completed');
    assert.deepEqual(calls[0].arguments, { title: 'Exact owner-selected issue' });
    await assert.rejects(capabilities.control({ action: 'approval', id: proposal.id, decision: 'approve', userId: directMessageOwnerId, channelId }), /cannot execute again/);
    assert.equal(calls.length, 1);
  } finally { await capabilities?.close(); await apps.close(); await rm(root, { recursive: true, force: true }); }
});

test('changed connector defaults or destructive classification require a new proposal without running the action', async () => {
  const { apps, calls, change } = fixture();
  try {
    const approved = await apps.validateAction({ tool: 'github.create_issue', arguments: { title: 'Issue' } });
    change({ ...actionTool, annotations: { readOnlyHint: false, destructiveHint: true } });
    await assert.rejects(apps.callApproved(approved), /changed/);
    change({ ...actionTool, inputSchema: { ...actionTool.inputSchema, properties: { ...actionTool.inputSchema.properties, visibility: { type: 'string', default: 'public' } } } });
    await assert.rejects(apps.callApproved(approved), /changed/);
    assert.equal(calls.length, 0);
  } finally { await apps.close(); }
});
