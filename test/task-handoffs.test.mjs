import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskHandoffs, sanitizeHandoffCommand } from '../src/proactive/task-handoffs.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const actor = { userId: directMessageOwnerId, channelId: '111111111111111111', guildId: null, explicitOwnerAction: true };
async function fixture(t, hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nova-handoff-'));
  const calls = [];
  const projection = { thread: { id: 'thread-1' }, runs: [{ id: 'run-1', ordinal: 1, status: 'running' }], runtimeRequests: [], turnItems: [] };
  const client = {
    projects: async () => [{ id: 'project-1', title: 'Approved project', workspaceRoot: root }],
    request: async (tag, payload) => {
      calls.push({ tag, payload });
      if (tag === 'server.getConfig') return { providers: [{ instanceId: 'codex', driver: 'codex', enabled: true, installed: true, auth: { status: 'authenticated' }, models: [{ slug: 'sol', name: 'Sol' }] }, { instanceId: 'claudeAgent', driver: 'claudeAgent', enabled: true, installed: true, auth: { status: 'authenticated' }, models: [{ slug: 'opus', name: 'Opus' }] }] };
      if (tag === 'orchestration.launchThread') return { threadId: 'thread-1', projection };
      if (tag === 'orchestration.getThreadProjection') return projection;
      return {};
    },
    subscribe: async () => () => {}, close: async () => {},
  };
  const manager = createTaskHandoffs({ client, root, ...hooks });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const request = { ...actor, projectId: 'project-1', harness: 'codex', model: 'sol', title: 'Implement explicit request', request: 'Make the requested change' };
  return { manager, calls, projection, request, root, client };
}

test('T3 handoffs validate owner DM, explicit approval, project, harness, and model before launch', async (t) => {
  const { manager, calls, request } = await fixture(t);
  for (const invalid of [{ userId: '222222222222222222' }, { guildId: '333333333333333333' }, { explicitOwnerAction: false }, { projectId: 'missing' }, { harness: 'untrusted' }, { model: 'invented' }]) await assert.rejects(manager.start({ ...request, ...invalid }));
  assert.equal(calls.filter(({ tag }) => tag === 'orchestration.launchThread').length, 0);
  const task = await manager.start(request);
  const launch = calls.find(({ tag }) => tag === 'orchestration.launchThread').payload;
  assert.equal(launch.runtimeMode, 'approval-required');
  assert.deepEqual(launch.modelSelection, { instanceId: 'codex', model: 'sol' });
  assert.deepEqual(launch.workspaceStrategy, { type: 'root' });
  assert.equal(task.state, 'running');
  await assert.rejects(manager.stop('unrelated-t3-task', actor), /Unknown/);
});

test('Claude Code selects actual claudeAgent provider and catalog model', async (t) => {
  const { manager, calls, request } = await fixture(t);
  await manager.start({ ...request, harness: 'claude-code', model: 'opus' });
  assert.deepEqual(calls.find(({ tag }) => tag === 'orchestration.launchThread').payload.modelSelection, { instanceId: 'claudeAgent', model: 'opus' });
});

test('real command events are sanitized and reasoning is never published', async (t) => {
  const progress = [];
  const { manager, request, projection } = await fixture(t, { onProgress: (value) => progress.push(value) });
  projection.turnItems.push({ id: 'reasoning', type: 'reasoning', text: 'private reasoning', status: 'running' }, { id: 'command', type: 'command_execution', input: 'TOKEN=secret-value npm test', status: 'running' });
  const task = await manager.start(request);
  await manager.status(task.id, actor);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].command, 'TOKEN=[redacted] npm test');
  assert.equal(progress[0].type, 'command_execution');
  assert.equal(sanitizeHandoffCommand('curl -H "Authorization: Bearer secret-token"').includes('secret-token'), false);
});

test('approvals bind exact task request and only single-use advertised decisions', async (t) => {
  const approvals = [];
  const { manager, request, projection, calls } = await fixture(t, { onApproval: (value) => approvals.push(value) });
  projection.runtimeRequests.push({ id: 'request-1', nodeId: 'node-1', kind: 'command', status: 'pending', responseCapability: { type: 'live' } });
  projection.turnItems.push({ id: 'approval-1', type: 'approval_request', requestId: 'request-1', prompt: 'Run tests', options: [{ decision: 'accept' }, { decision: 'decline' }, { decision: 'acceptAlways' }] });
  const task = await manager.start(request);
  assert.deepEqual(approvals[0].decisions, ['accept', 'decline']);
  await assert.rejects(manager.respondApproval(task.id, 'different-request', 'accept', actor));
  await assert.rejects(manager.respondApproval(task.id, 'request-1', 'acceptAlways', actor));
  await manager.respondApproval(task.id, 'request-1', 'accept', actor);
  const approvalCall = calls.find(({ payload }) => payload?.type === 'runtime-request.respond');
  assert.equal(approvalCall.payload.threadId, task.threadId);
  assert.equal(approvalCall.payload.requestId, 'request-1');
  projection.runtimeRequests[0].status = 'resolved';
  await assert.rejects(manager.respondApproval(task.id, 'request-1', 'accept', actor), /unavailable/);
});

test('steer and stop call supported dispatch protocol without relaunch', async (t) => {
  const { manager, request, calls } = await fixture(t);
  const task = await manager.start(request);
  await manager.steer(task.id, 'Use the existing helper', actor);
  assert.deepEqual(calls.find(({ payload }) => payload?.type === 'message.dispatch').payload.dispatchMode, { type: 'steer_active', targetRunId: 'run-1' });
  await manager.stop(task.id, actor);
  assert.equal(calls.find(({ payload }) => payload?.type === 'run.interrupt').payload.holdQueue, true);
  assert.equal(calls.filter(({ tag }) => tag === 'orchestration.launchThread').length, 1);
});

test('durable task metadata excludes prompts commands approvals and replies', async (t) => {
  const { manager, request, root, projection } = await fixture(t);
  projection.turnItems.push({ id: 'reply', type: 'assistant_message', streaming: false, text: 'Sensitive final contents', status: 'completed' });
  const task = await manager.start(request);
  const saved = JSON.parse(await readFile(join(root, `${task.id}.json`), 'utf8'));
  assert.equal(saved.threadId, 'thread-1');
  assert.equal(saved.latestReply, undefined);
  assert.equal(saved.pendingApprovals, undefined);
  assert.equal(JSON.stringify(saved).includes(request.request), false);
});

test('unconfirmed launch persists its deterministic ID and reads status without launch replay', async (t) => {
  const { manager, request, client, calls } = await fixture(t);
  const original = client.request;
  let requestedThread;
  client.request = async (tag, payload) => {
    if (tag === 'orchestration.launchThread') { requestedThread = payload.threadId; calls.push({ tag, payload }); throw new Error('Transport closed'); }
    return original(tag, payload);
  };
  await assert.rejects(manager.start(request), /could not be confirmed/);
  const saved = (await manager.list(actor))[0];
  assert.equal(saved.state, 'unconfirmed');
  assert.equal(saved.threadId, requestedThread);
  assert.equal(saved.id, requestedThread);
  await manager.status(saved.id, actor);
  assert.equal(calls.filter(({ tag }) => tag === 'orchestration.launchThread').length, 1);
});

test('notification failures do not turn a confirmed handoff into an unknown launch', async (t) => {
  const { manager, request, projection } = await fixture(t, { onProgress: () => { throw new Error('Discord temporarily unavailable'); } });
  projection.turnItems.push({ id: 'command', type: 'command_execution', input: 'npm test', status: 'running' });
  const task = await manager.start(request);
  assert.equal(task.state, 'running');
  assert.equal(task.error, null);
});

test('task mutation and results remain bound to their originating owner DM', async (t) => {
  const { manager, request } = await fixture(t);
  const task = await manager.start(request);
  const otherDm = { ...actor, channelId: '222222222222222222' };
  assert.deepEqual(await manager.list(otherDm), []);
  await assert.rejects(manager.status(task.id, otherDm), /this owner DM/);
  await assert.rejects(manager.stop(task.id, otherDm), /this owner DM/);
  await assert.rejects(manager.steer(task.id, 'Changed request', otherDm), /this owner DM/);
});
