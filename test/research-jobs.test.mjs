import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchJobs } from '../src/proactive/research-jobs.mjs';

const owner = '291140236979732480';
const guildId = '1229046849520926720';
const channelId = '1241494817049936024';
const threadId = '1555972640768790730';
const introId = '1555972640768790731';
const bot = { id: '1555935515809939477' };

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nova-jobs-test-'));
  const calls = [];
  const incoming = [];
  let callback;
  let closes = 0;
  let statistics = { queued: 0, generating: false, errors: 0 };
  const client = {
    getChannel: async (id) => id === channelId ? { id, guild_id: guildId, type: 0 } : { id, guild_id: guildId, parent_id: channelId, type: 11 },
    createThread: async (id, payload) => { calls.push({ type: 'thread', id, payload }); return { id: threadId }; },
    sendMessage: async (id, payload) => { calls.push({ type: 'message', id, payload }); return { id: introId }; },
    ...overrides.client,
  };
  const createRuntime = async (options) => {
    callback = options.onStatus;
    return { receive: async (message) => { incoming.push(message); statistics = { ...statistics, queued: 1 }; callback(statistics); return true; },
      status: () => ({ statistics }), close: async () => { closes += 1; } };
  };
  const jobs = createResearchJobs({ service: { accountById: () => ({ client }) }, accountId: 'default', bot, root, createRuntime: overrides.createRuntime || createRuntime });
  return { root, calls, incoming, jobs, closes: () => closes, update: (value) => { statistics = { ...statistics, ...value }; callback(statistics); }, cleanup: async () => { await jobs.close(); await rm(root, { recursive: true, force: true }); } };
}

const request = { guildId, channelId, userId: owner, request: 'Research the mobile hotbar controls', name: 'Hotbar research' };

test('owner research creates one public thread and submits a host-proven owner request', async () => {
  const example = await fixture();
  try {
    const job = await example.jobs.start(request);
    assert.equal(job.state, 'queued');
    assert.equal(job.threadId, threadId);
    assert.deepEqual(example.calls.map((call) => call.type), ['thread', 'message']);
    assert.equal(example.calls[0].payload.type, 11);
    assert.deepEqual(example.calls[1].payload.allowed_mentions, { parse: [] });
    assert.equal(example.calls[1].payload.enforce_nonce, true);
    assert.equal(example.incoming[0].id, introId);
    assert.equal(example.incoming[0].author.id, owner);
    assert.equal(example.incoming[0].content, request.request);
    assert.equal(example.incoming[0].hostProvenance.type, 'owner_research_job');
    example.update({ generating: true, queued: 0 });
    assert.equal(example.jobs.status(job.id).state, 'running');
    example.update({ generating: false });
    assert.equal(example.jobs.status(job.id).state, 'completed');
    await example.jobs.close();
    const saved = await readFile(join(example.root, (await readdir(example.root)).find((name) => name.endsWith('.json'))), 'utf8');
    assert.equal(saved.includes(request.request), false);
    assert.equal(saved.includes(request.name), false);
    assert.equal(JSON.parse(saved).state, 'completed');
    assert.equal(example.closes(), 1);
  } finally { await example.cleanup(); }
});

test('other users and foreign channel scopes cannot create research threads', async () => {
  const example = await fixture({ client: { getChannel: async () => ({ guild_id: '100000000000000000', type: 0 }) } });
  try {
    await assert.rejects(example.jobs.start({ ...request, userId: '100000000000000001' }), /Only the owner/);
    await assert.rejects(example.jobs.start(request), /accessible text channel/);
    assert.equal(example.calls.length, 0);
  } finally { await example.cleanup(); }
});

test('an uncertain thread creation is recorded as failed and is never retried', async () => {
  let attempts = 0;
  const example = await fixture({ client: { createThread: async () => { attempts += 1; throw new Error('Network disconnected after request'); } } });
  try {
    await assert.rejects(example.jobs.start(request), (error) => { assert.equal(error.job.state, 'failed'); assert.equal(error.job.threadId, null); return true; });
    assert.equal(attempts, 1);
    assert.equal(example.jobs.list().length, 1);
    assert.equal(example.calls.length, 0);
  } finally { await example.cleanup(); }
});

test('existing active public threads are reused only beneath the authorized source channel', async () => {
  const example = await fixture();
  try {
    const job = await example.jobs.start({ ...request, existingThread: threadId });
    assert.equal(job.threadId, threadId);
    assert.deepEqual(example.calls.map((call) => call.type), ['message']);
    await example.jobs.stop(job.id);
    assert.equal(example.jobs.status(job.id).state, 'cancelled');
    assert.equal(example.closes(), 1);
    await example.jobs.close();
    assert.equal(example.closes(), 1);
  } finally { await example.cleanup(); }
});

test('job errors settle as failed and restored records never restart research automatically', async () => {
  const example = await fixture();
  let replacement;
  try {
    const job = await example.jobs.start(request);
    example.update({ queued: 0, errors: 1 });
    assert.equal(example.jobs.status(job.id).state, 'failed');
    await example.jobs.close();
    let launched = false;
    replacement = createResearchJobs({ service: { accountById: () => ({ client: {} }) }, accountId: 'default', bot, root: example.root, createRuntime: async () => { launched = true; } });
    await replacement.ready();
    assert.equal(replacement.list()[0].state, 'failed');
    assert.equal(launched, false);
  } finally { await replacement?.close(); await example.cleanup(); }
});

test('an existing research thread cannot accept two active jobs', async () => {
  const example = await fixture();
  try {
    await example.jobs.start({ ...request, existingThread: threadId });
    await assert.rejects(example.jobs.start({ ...request, existingThread: threadId }), /already has an active/);
    assert.equal(example.calls.length, 1);
    assert.equal(example.incoming.length, 1);
  } finally { await example.cleanup(); }
});
