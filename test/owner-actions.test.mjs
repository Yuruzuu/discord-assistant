import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat, unlink, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerActions, formatOwnerAction } from '../src/proactive/owner-actions.mjs';
import { createOwnerCapabilities } from '../src/proactive/owner-capabilities.mjs';
import { directMessageOwnerId as userId } from '../src/proactive/target.mjs';

const channelId = '200000000000000001';
const otherChannelId = '200000000000000002';
const initialTime = Date.UTC(2026, 9, 5);
const request = () => ({ kind: 'app', tool: 'github.create_issue', arguments: { title: 'Hotbar import', body: 'Implement the approved hotbar specification', labels: ['approved'] } });

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nova-owner-actions-')); const delivered = []; const executed = []; let clock = initialTime;
  const dependencies = { accountId: 'default', channelId, root, now: () => clock,
    deliver: async (action) => { delivered.push(action); }, execute: async (action, execution) => { executed.push({ action, execution }); return { id: 'result-1' }; }, ...options };
  const manager = createOwnerActions(dependencies); await manager.ready;
  return { manager, root, dependencies, delivered, executed, setClock: (value) => { clock = value; }, close: async () => { await manager.close(); await rm(root, { recursive: true, force: true }); } };
}

test('action preparation and decisions enforce owner identity and the exact DM', async () => {
  const value = await fixture();
  try {
    await assert.rejects(value.manager.prepare({ userId: 'stranger', request: request() }), /Only the owner/);
    const proposal = await value.manager.prepare({ userId, title: 'Create the issue', request: request() });
    assert.equal(value.executed.length, 0); assert.equal(value.delivered.length, 1);
    await assert.rejects(value.manager.decide({ userId: 'stranger', id: proposal.id, decision: 'approve' }), /Only the owner/);
    await assert.rejects(value.manager.decide({ userId, channelId: otherChannelId, id: proposal.id, decision: 'approve' }), /different DM/);
    await assert.rejects(value.manager.list({ userId: 'stranger' }), /Only the owner/);
    assert.equal(value.executed.length, 0);
    assert.equal((await stat(join(value.root, `default-${channelId}.json`))).mode & 0o777, 0o600);
  } finally { await value.close(); }
});

test('the exact action is deep-copied before review and execution despite mutation of caller, preview or list snapshots', async () => {
  const value = await fixture();
  try {
    const original = request(); const expected = structuredClone(original);
    const proposal = await value.manager.prepare({ userId, title: 'Create issue', request: original });
    original.arguments.body = 'Changed after approval preview'; original.arguments.labels.push('malicious');
    value.delivered[0].request.arguments.title = 'Changed by preview callback';
    const listed = await value.manager.list({ userId }); listed[0].request.arguments.body = 'Changed through returned list';
    const decision = await value.manager.decide({ userId, channelId, id: proposal.id, decision: 'approve' });
    assert.equal(decision.state, 'completed'); assert.deepEqual(value.executed[0].action, expected);
    const journal = JSON.parse(await readFile(join(value.root, `default-${channelId}.json`), 'utf8'));
    assert.deepEqual(journal.actions[0].request, expected); assert.equal(journal.actions[0].state, 'completed');
    await assert.rejects(value.manager.decide({ userId, id: proposal.id, decision: 'approve' }), /cannot execute again/);
    assert.equal(value.executed.length, 1);
  } finally { await value.close(); }
});

test('concurrent approval decisions execute at most once', async () => {
  let release; let started; const waiting = new Promise((resolve) => { release = resolve; }); const began = new Promise((resolve) => { started = resolve; }); let executions = 0;
  const value = await fixture({ execute: async () => { executions += 1; started(); await waiting; return { success: true }; } });
  try {
    const proposal = await value.manager.prepare({ userId, request: request() });
    const first = value.manager.decide({ userId, id: proposal.id, decision: 'approve' }); await began;
    await assert.rejects(value.manager.decide({ userId, id: proposal.id, decision: 'approve' }), /cannot execute again/);
    await assert.rejects(value.manager.decide({ userId, id: proposal.id, decision: 'decline' }), /cannot execute again/);
    release(); assert.equal((await first).state, 'completed'); assert.equal(executions, 1);
  } finally { release(); await value.close(); }
});

test('declined and expired approvals never execute', async () => {
  const value = await fixture({ ttlMs: 1000 });
  try {
    const declined = await value.manager.prepare({ userId, request: request() });
    assert.equal((await value.manager.decide({ userId, id: declined.id, decision: 'decline' })).state, 'declined');
    await assert.rejects(value.manager.decide({ userId, id: declined.id, decision: 'approve' }), /cannot execute again/);
    const expired = await value.manager.prepare({ userId, request: request() }); value.setClock(initialTime + 1001);
    await assert.rejects(value.manager.decide({ userId, id: expired.id, decision: 'approve' }), /expired/);
    assert.equal((await value.manager.list({ userId })).find((action) => action.id === expired.id).state, 'expired');
    assert.equal(value.executed.length, 0);
  } finally { await value.close(); }
});

test('unknown execution outcomes remain blocked across restarts and are never automatically retried', async () => {
  let executions = 0; const value = await fixture({ execute: async () => { executions += 1; throw new Error('transport disappeared'); } }); let restored;
  try {
    const proposal = await value.manager.prepare({ userId, request: request() });
    await assert.rejects(value.manager.decide({ userId, id: proposal.id, decision: 'approve' }), /unknown outcome/);
    await assert.rejects(value.manager.decide({ userId, id: proposal.id, decision: 'approve' }), /cannot execute again/);
    await value.manager.close(); restored = createOwnerActions({ ...value.dependencies, execute: async () => { executions += 1; } }); await restored.ready;
    assert.equal((await restored.list({ userId }))[0].state, 'unknown');
    await assert.rejects(restored.decide({ userId, id: proposal.id, decision: 'approve' }), /cannot execute again/);
    assert.equal(executions, 1);
  } finally { await restored?.close(); await value.close(); }
});

test('restart converts an interrupted executing journal entry to unknown without executing it', async () => {
  const value = await fixture(); let restored;
  try {
    const proposal = await value.manager.prepare({ userId, request: request() }); await value.manager.close();
    const filename = join(value.root, `default-${channelId}.json`); const journal = JSON.parse(await readFile(filename, 'utf8'));
    journal.actions[0].state = 'executing'; await writeFile(filename, JSON.stringify(journal));
    restored = createOwnerActions(value.dependencies); await restored.ready;
    assert.equal((await restored.list({ userId }))[0].state, 'unknown');
    await assert.rejects(restored.decide({ userId, id: proposal.id, decision: 'approve' }), /cannot execute again/);
    assert.equal(value.executed.length, 0);
  } finally { await restored?.close(); await value.close(); }
});

test('rejected executions and connector isError results become terminal failed actions', async () => {
  const rejected = await fixture({ execute: async () => { throw Object.assign(new Error('Not permitted'), { approvalRejected: true }); } });
  const failed = await fixture({ execute: async () => ({ isError: true }) });
  try {
    const first = await rejected.manager.prepare({ userId, request: request() });
    await assert.rejects(rejected.manager.decide({ userId, id: first.id, decision: 'approve' }), /rejected/);
    assert.equal((await rejected.manager.list({ userId }))[0].state, 'failed');
    await assert.rejects(rejected.manager.decide({ userId, id: first.id, decision: 'approve' }), /cannot execute again/);
    const second = await failed.manager.prepare({ userId, request: request() });
    assert.equal((await failed.manager.decide({ userId, id: second.id, decision: 'approve' })).state, 'failed');
  } finally { await rejected.close(); await failed.close(); }
});

test('credential-like keys including camel case, deep requests and oversized proposals are rejected before delivery', async () => {
  const value = await fixture();
  try {
    for (const key of ['password', 'secret', 'token', 'accessToken', 'apiKey', 'api_key', 'clientSecret', 'authorization', 'cookie', 'credentials']) {
      await assert.rejects(value.manager.prepare({ userId, request: { ...request(), arguments: { nested: { [key]: 'private' } } } }), /credentials/, key);
    }
    await assert.rejects(value.manager.prepare({ userId, request: { ...request(), arguments: { body: 'a'.repeat(16000) } } }), /exceeds/);
    let deep = {}; for (let index = 0; index < 18; index += 1) deep = { child: deep };
    await assert.rejects(value.manager.prepare({ userId, request: { ...request(), arguments: deep } }), /deeply nested/);
    assert.equal(value.delivered.length, 0); assert.equal(value.executed.length, 0); assert.deepEqual(await value.manager.list({ userId }), []);
  } finally { await value.close(); }
});

test('saved proposal tampering rejects journal loading rather than executing changed arguments', async () => {
  const value = await fixture(); let restored;
  try {
    await value.manager.prepare({ userId, request: request() }); await value.manager.close();
    const filename = join(value.root, `default-${channelId}.json`); const journal = JSON.parse(await readFile(filename, 'utf8'));
    journal.actions[0].request.arguments.body = 'Tampered after approval'; await writeFile(filename, JSON.stringify(journal));
    restored = createOwnerActions(value.dependencies); await assert.rejects(restored.ready, /Invalid saved action proposal/);
    assert.equal(value.executed.length, 0);
  } finally { await restored?.close(); await value.close(); }
});

test('large approval previews attach the complete exact proposal and never execute before owner approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-large-approval-')); const delivered = []; const executed = [];
  const client = { sendMessageFiles: async (target, payload, files) => { delivered.push({ target, payload, files }); return { id: '300000000000000001' }; } };
  const service = { accountById: () => ({ client }) };
  const capabilities = await createOwnerCapabilities({ service, accountId: 'default', channelId, settings: { reminders: false, handoffs: false }, root,
    connectedApps: { callApproved: async (action) => { executed.push(action); return { success: true }; } }, actionComponents: () => [] });
  try {
    const largeRequest = { ...request(), arguments: { body: 'The exact full proposal. '.repeat(100) } };
    const proposal = await capabilities.actions.prepare({ userId, title: 'Create the large issue', request: largeRequest });
    assert.equal(executed.length, 0); assert.equal(delivered.length, 1); assert.equal(delivered[0].target, channelId);
    assert.match(delivered[0].payload.content, /full proposal is attached/); assert.deepEqual(delivered[0].payload.allowed_mentions, { parse: [] });
    assert.equal(delivered[0].files.length, 1); assert.deepEqual(JSON.parse(delivered[0].files[0].content), largeRequest);
    assert.ok(delivered[0].files[0].content.length > 1500);
    await capabilities.control({ userId, channelId, action: 'approval', id: proposal.id, decision: 'approve' });
    assert.equal(executed.length, 1); assert.equal(executed[0].tool, largeRequest.tool); assert.deepEqual(executed[0].arguments, largeRequest.arguments);
    assert.doesNotMatch(formatOwnerAction({ id: proposal.id, title: 'Hello ``` injected', request: request(), expiresAt: initialTime }), /Hello ``` injected/);
  } finally { await capabilities.close(); await rm(root, { recursive: true, force: true }); }
});

test('independent managers and child processes cannot reopen an owned approval journal', async () => {
  const value = await fixture(); let competitor; let reopened;
  try {
    competitor = createOwnerActions(value.dependencies);
    await assert.rejects(competitor.ready, /already owned/); await competitor.close();
    const script = `import { createOwnerActions } from ${JSON.stringify(new URL('../src/proactive/owner-actions.mjs', import.meta.url).href)};
      const manager = createOwnerActions({accountId:'default',channelId:${JSON.stringify(channelId)},root:process.argv[1],execute:async()=>{},deliver:async()=>{}});
      try { await manager.ready; process.stdout.write('unexpectedly acquired'); process.exitCode=1; }
      catch(error) { process.stdout.write(error.message); }
      finally { await manager.close(); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, value.root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(exitCode, 0, errors); assert.match(output, /already owned/);
    await value.manager.close(); reopened = createOwnerActions(value.dependencies); await reopened.ready;
    await reopened.prepare({ userId, request: request() }); assert.equal(value.delivered.length, 1);
  } finally { await competitor?.close(); await reopened?.close(); await value.close(); }
});

test('expired proposals free capacity during preparation and inspection without restarting', async () => {
  const value = await fixture({ ttlMs: 1000 });
  try {
    for (let index = 0; index < 20; index += 1) await value.manager.prepare({ userId, title: `Approval ${index}`, request: request() });
    await assert.rejects(value.manager.prepare({ userId, request: request() }), /pending approvals/);
    value.setClock(initialTime + 1001);
    const fresh = await value.manager.prepare({ userId, request: request() });
    const listed = await value.manager.list({ userId });
    assert.equal(listed.filter((action) => action.state === 'expired').length, 20);
    assert.equal(listed.find((action) => action.id === fresh.id).state, 'pending');
    value.setClock(initialTime + 2002); assert.equal((await value.manager.list({ userId })).find((action) => action.id === fresh.id).state, 'expired');
    assert.equal(value.executed.length, 0);
  } finally { await value.close(); }
});

test('history pruning retains the oldest pending and unknown approvals across restart', async () => {
  const value = await fixture({ execute: async () => { throw new Error('Unknown transport outcome'); } }); let restored;
  try {
    const pending = await value.manager.prepare({ userId, title: 'Keep pending', request: request() });
    const unknown = await value.manager.prepare({ userId, title: 'Keep unknown', request: request() });
    await assert.rejects(value.manager.decide({ userId, id: unknown.id, decision: 'approve' }), /unknown outcome/);
    for (let index = 0; index < 105; index += 1) {
      const proposal = await value.manager.prepare({ userId, title: `Declined ${index}`, request: request() });
      await value.manager.decide({ userId, id: proposal.id, decision: 'decline' });
    }
    const journal = JSON.parse(await readFile(join(value.root, `default-${channelId}.json`), 'utf8'));
    assert.equal(journal.actions.length, 100);
    assert.equal(journal.actions.find((action) => action.id === pending.id).state, 'pending');
    assert.equal(journal.actions.find((action) => action.id === unknown.id).state, 'unknown');
    await value.manager.close(); restored = createOwnerActions(value.dependencies); await restored.ready;
    const listed = await restored.list({ userId }); assert.equal(listed.length, 100);
    assert.ok(listed.some((action) => action.id === pending.id)); assert.ok(listed.some((action) => action.id === unknown.id));
  } finally { await restored?.close(); await value.close(); }
});

test('close waits for startup and blocks further preparation, inspection and decisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-actions-close-')); let reopened;
  const dependencies = { accountId: 'default', channelId, root, execute: async () => {}, deliver: async () => {} };
  const manager = createOwnerActions(dependencies);
  try {
    await manager.close(); await manager.ready;
    await assert.rejects(manager.prepare({ userId, request: request() }), /stopped/);
    await assert.rejects(manager.list({ userId }), /stopped/);
    await assert.rejects(manager.decide({ userId, id: 'unknown', decision: 'approve' }), /stopped/);
    await assert.rejects(stat(join(root, `default-${channelId}.json.lock`)), { code: 'ENOENT' });
    reopened = createOwnerActions(dependencies); await reopened.ready;
  } finally { await manager.close(); await reopened?.close(); await rm(root, { recursive: true, force: true }); }
});

test('startup and persistence failures release approval journal ownership safely', async () => {
  const value = await fixture(); let broken; let reopened;
  try {
    const filename = join(value.root, `default-${channelId}.json`);
    await value.manager.close(); await writeFile(filename, '{invalid json');
    broken = createOwnerActions(value.dependencies); await assert.rejects(broken.ready, SyntaxError); await broken.close();
    await assert.rejects(stat(`${filename}.lock`), { code: 'ENOENT' });
    await unlink(filename); reopened = createOwnerActions(value.dependencies); await reopened.ready;
    await unlink(filename); await mkdir(filename);
    await assert.rejects(reopened.prepare({ userId, request: request() }), /EISDIR/); await reopened.close();
    await assert.rejects(stat(`${filename}.lock`), { code: 'ENOENT' });
    await assert.rejects(reopened.prepare({ userId, request: request() }), /stopped/);
    assert.equal(value.delivered.length, 0); assert.equal(value.executed.length, 0);
  } finally { await broken?.close(); await reopened?.close(); await value.close(); }
});
