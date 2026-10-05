import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerCapabilities } from '../src/proactive/owner-capabilities.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const channelId = '111111111111111111';
const actor = { userId: directMessageOwnerId, channelId, guildId: null };
async function fixture(t, { failReady = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nova-owner-tasks-'));
  const operations = []; const messages = []; const edits = []; const components = [];
  let hooks, closed = false;
  const handoffs = Object.fromEntries(['start', 'status', 'list', 'steer', 'stop', 'respondApproval', 'catalog'].map((method) => [method, async (...argumentsList) => { operations.push({ method, argumentsList }); return { success: true }; }]));
  handoffs.ready = async () => { if (failReady) throw new Error('Startup failed'); };
  handoffs.close = async () => { closed = true; };
  const client = { sendMessage: async (destination, body) => { messages.push({ destination, body }); return { id: String(111111111111111100n + BigInt(messages.length)) }; },
    editMessage: async (destination, messageId, body) => { edits.push({ destination, messageId, body }); return { id: messageId }; },
  };
  const configuration = { service: { accountById: () => ({ client }) }, accountId: 'bot', channelId,
    settings: { reminders: false }, root, handoffFactory: (options) => { hooks = options; return handoffs; },
    actionComponents: (choices) => { components.push(choices); return [{ type: 1, components: [] }]; },
  };
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { configuration, operations, messages, edits, components, hooks: () => hooks, closed: () => closed };
}

test('owner handoff controls supply trusted actor and ignore model supplied identity', async (t) => {
  const { configuration, operations } = await fixture(t);
  const capability = await createOwnerCapabilities(configuration); t.after(() => capability.close());
  await capability.control({ ...actor, action: 'handoff', operation: 'start', configuration: { projectId: 'project', harness: 'claude-code', model: 'opus', userId: 'spoofed', channelId: '222222222222222222', guildId: '333333333333333333', explicitOwnerAction: false } });
  const launched = operations[0].argumentsList[0];
  assert.equal(launched.userId, directMessageOwnerId);
  assert.equal(launched.channelId, channelId);
  assert.equal(launched.guildId, null);
  assert.equal(launched.explicitOwnerAction, true);
  await assert.rejects(capability.control({ ...actor, action: 'handoff', operation: 'stop', id: 'task', channelId: '222222222222222222' }), /owner DM/);
  await assert.rejects(capability.control({ ...actor, action: 'handoff', operation: 'catalog', guildId: '333333333333333333' }), /owner DM/);
  await assert.rejects(capability.control({ ...actor, action: 'handoff', operation: 'start', userId: '222222222222222222' }), /owner DM/);
  assert.equal(operations.length, 1);
});

test('handoff proposals remain inert until exact owner approval and cannot run twice', async (t) => {
  const { configuration, operations, messages } = await fixture(t);
  const capability = await createOwnerCapabilities(configuration); t.after(() => capability.close());
  const proposal = await capability.actions.prepare({ userId: directMessageOwnerId, title: 'Implement selected task', request: { kind: 'handoff', configuration: { projectId: 'project', harness: 'codex', model: 'sol', title: 'Task', request: 'Implement requested change' } } });
  assert.equal(operations.length, 0);
  assert.equal(messages[0].destination, channelId);
  assert.match(messages[0].body.content, /Approving runs this exact action once/);
  await capability.control({ ...actor, action: 'approval', id: proposal.id, decision: 'approve' });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].method, 'start');
  assert.equal(operations[0].argumentsList[0].explicitOwnerAction, true);
  await assert.rejects(capability.control({ ...actor, action: 'approval', id: proposal.id, decision: 'approve' }), /resolved/);
  assert.equal(operations.length, 1);
});

test('task approval notifications use fenced commands and exact task/request opaque choices', async (t) => {
  const { configuration, messages, components, hooks, operations } = await fixture(t);
  const capability = await createOwnerCapabilities(configuration); t.after(() => capability.close());
  await hooks().onApproval({ taskId: 'task-1', requestId: 'request-1', channelId, command: 'npm test', decisions: ['accept', 'decline', 'acceptAlways'] });
  assert.match(messages[0].body.content, /```\nnpm test\n```/);
  assert.deepEqual(components[0].map((choice) => choice.decision), ['accept', 'decline']);
  assert.equal(components[0][0].taskId, 'task-1');
  assert.equal(components[0][0].requestId, 'request-1');
  await capability.control({ ...actor, action: 'task-approval', taskId: 'task-1', requestId: 'request-1', decision: 'accept' });
  assert.deepEqual(operations[0].argumentsList.slice(0, 3), ['task-1', 'request-1', 'accept']);
  await hooks().onApproval({ taskId: 'other-task', requestId: 'other-request', channelId: '222222222222222222', command: 'private other DM', decisions: ['accept'] });
  assert.equal(messages.length, 1);
});

test('task completion ignores other DMs and closes managers on shutdown or failed startup', async (t) => {
  const good = await fixture(t);
  const capability = await createOwnerCapabilities(good.configuration);
  await good.hooks().onComplete({ id: 'task', state: 'completed', updatedAt: 1, channelId: '222222222222222222', latestReply: 'Other DM text' });
  assert.equal(good.messages.length, 0);
  await good.hooks().onComplete({ id: 'task', state: 'completed', updatedAt: 1, channelId, latestReply: 'Verified result' });
  assert.match(good.messages[0].body.content, /Verified result/);
  await capability.close();
  assert.equal(good.closed(), true);
  const bad = await fixture(t, { failReady: true });
  await assert.rejects(createOwnerCapabilities(bad.configuration), /Startup failed/);
  assert.equal(bad.closed(), true);
});
