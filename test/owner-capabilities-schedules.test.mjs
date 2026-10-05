import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerCapabilities } from '../src/proactive/owner-capabilities.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { directMessageOwnerId as userId } from '../src/proactive/target.mjs';

const channelId = '200000000000000001';
const serverChannelId = '200000000000000002';
const guildId = '100000000000000001';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nova-owner-schedules-'));
  const sends = []; const appCalls = []; let failure; let appStatus = 'pending';
  const client = {
    getGuild: async () => ({ id: guildId }),
    getChannel: async (id) => id === channelId ? { id, type: 1, recipients: [{ id: userId }] } : { id, type: 0, guild_id: guildId },
    searchGuildMessages: async () => ({ total_results: 0, messages: [] }),
    sendMessage: async (target, payload) => {
      if (failure) throw failure;
      sends.push({ target, payload }); return { id: String(300000000000000000n + BigInt(sends.length)), channel_id: target };
    },
  };
  const service = { accounts: [{ id: 'default' }], accountById: () => ({ id: 'default', client }) };
  const connectedApps = {
    list: async () => ({ tools: [{ name: 'github.read_pull_request' }] }),
    call: async (args) => { appCalls.push(args); return { structuredContent: { status: appStatus, secretContext: 'private result must remain host-side' } }; },
  };
  const settings = { reminders: true, handoffs: false, apps: true, timeZone: 'Asia/Manila' };
  const capabilities = await createOwnerCapabilities({ service, accountId: 'default', channelId, settings, root, connectedApps, actionComponents: () => [] });
  const readTools = createDiscordReadTools(service, { channelId, directMessages: true, guildId: null }, { connectedApps, schedules: capabilities.schedules, ownerActions: capabilities.actions });
  return { capabilities, readTools, service, sends, appCalls, setFailure: (value) => { failure = value; }, setStatus: (value) => { appStatus = value; }, close: async () => { await capabilities.close(); await rm(root, { recursive: true, force: true }); } };
}

test('owner schedule tools prepare immutable proposals and approval is required before creation', async () => {
  const value = await fixture();
  try {
    const toolResult = await value.readTools.call('nova_prepare_reminder', { title: 'Review hotbar', reminder: { content: 'Review hotbar', runAt: new Date(Date.now() + 3600000).toISOString() } });
    const proposal = JSON.parse(toolResult.contentItems[0].text);
    assert.equal(proposal.state, 'pending'); assert.deepEqual(await value.capabilities.schedules.list({ userId }), []);
    assert.equal(value.sends.length, 1); assert.match(value.sends[0].payload.content, /Approval/);
    await assert.rejects(value.capabilities.control({ userId: 'stranger', channelId, action: 'approval', id: proposal.id, decision: 'approve' }), /owner DM/);
    await assert.rejects(value.capabilities.control({ userId, channelId: serverChannelId, action: 'approval', id: proposal.id, decision: 'approve' }), /owner DM/);
    const approval = await value.capabilities.control({ userId, channelId, action: 'approval', id: proposal.id, decision: 'approve' });
    assert.equal(approval.state, 'completed'); assert.equal((await value.capabilities.schedules.list({ userId })).length, 1);
    assert.equal(value.sends.length, 1);
    await assert.rejects(value.capabilities.control({ userId, channelId, action: 'approval', id: proposal.id, decision: 'approve' }), /cannot execute again/);
    assert.equal((await value.capabilities.schedules.list({ userId }))[0].timeZone, 'Asia/Manila');
    const serverTools = createDiscordReadTools(value.service, { channelId: serverChannelId, directMessages: false, guildId }, { schedules: value.capabilities.schedules, ownerActions: value.capabilities.actions });
    assert.equal(serverTools.has('nova_prepare_reminder'), false); assert.equal(serverTools.has('nova_list_schedules'), false);
  } finally { await value.close(); }
});

test('explicit owner controls update and cancel schedules; notifications go only to owner DM', async () => {
  const value = await fixture();
  try {
    const created = await value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'add', configuration: { content: 'Review hotbar', runAt: Date.now() + 3600000 } });
    const paused = await value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'update', id: created.id, configuration: { paused: true } });
    assert.equal(paused.paused, true);
    const resumed = await value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'update', id: created.id, configuration: { paused: false, content: 'Review new spec' } });
    assert.equal(resumed.nextRunAt, created.runAt);
    await assert.rejects(value.capabilities.control({ userId, channelId, guildId, action: 'reminder', operation: 'run', id: created.id }), /owner DM/);
    await value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'run', id: created.id });
    assert.equal(value.sends.length, 1); assert.equal(value.sends[0].target, channelId);
    assert.equal(value.sends[0].payload.content, 'Reminder: Review new spec');
    assert.deepEqual(value.sends[0].payload.allowed_mentions, { parse: [] }); assert.equal(value.sends[0].payload.enforce_nonce, true);
    assert.ok(value.sends[0].payload.nonce.length <= 25);
    await value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'remove', id: created.id });
    assert.deepEqual(await value.capabilities.schedules.list({ userId }), []);
  } finally { await value.close(); }
});

test('quiet read-only app alert checks make no model or Discord calls until a condition changes', async () => {
  const value = await fixture();
  try {
    const created = await value.capabilities.control({ userId, channelId, action: 'alert', operation: 'add', configuration: {
      content: 'The hotbar PR passed CI', repeat: true,
      condition: { type: 'app', tool: 'github.read_pull_request', arguments: { number: 1 }, predicate: { path: ['status'], operator: 'equals', value: 'passed' } },
    } });
    const quiet = await value.capabilities.control({ userId, channelId, action: 'alert', operation: 'run', id: created.id });
    assert.equal(quiet.matched, false); assert.equal(value.sends.length, 0); assert.equal(value.appCalls.length, 1);
    value.setStatus('passed'); await value.capabilities.control({ userId, channelId, action: 'alert', operation: 'run', id: created.id });
    assert.equal(value.sends.length, 1); assert.equal(value.sends[0].target, channelId);
    assert.equal(value.sends[0].payload.content, 'Alert: The hotbar PR passed CI'); assert.doesNotMatch(value.sends[0].payload.content, /secretContext|private result/);
    const unchanged = await value.capabilities.control({ userId, channelId, action: 'alert', operation: 'run', id: created.id });
    assert.equal(unchanged.unchanged, true); assert.equal(value.sends.length, 1);
  } finally { await value.close(); }
});

test('schedule delivery failures halt the capability until the owner resolves its outcome', async () => {
  const value = await fixture();
  try {
    const reminder = await value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'add', configuration: { content: 'Review', runAt: Date.now() + 3600000 } });
    value.setFailure(Object.assign(new Error('Connection lost'), { status: 503 }));
    await assert.rejects(value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'run', id: reminder.id }), /Connection lost/);
    await assert.rejects(value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'run', id: reminder.id }), /verification/);
    assert.equal(value.sends.length, 0);
    const schedule = (await value.capabilities.schedules.list({ userId }))[0]; assert.equal(schedule.pendingDelivery.sendStatus, 'unknown');
    value.setFailure(null);
    await value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'resolve', id: reminder.id, configuration: { delivered: false } });
    await value.capabilities.control({ userId, channelId, action: 'reminder', operation: 'run', id: reminder.id });
    assert.equal(value.sends.length, 1);
  } finally { await value.close(); }
});
