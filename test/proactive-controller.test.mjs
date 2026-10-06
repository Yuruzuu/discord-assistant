import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createProactiveController } from '../src/proactive/controller.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';
import { directMessagePaths, serverMentionPaths } from '../src/proactive/state.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';

test('listener starts only on request, survives its caller, and stops through authenticated control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discord-controller-'));
  const entrypoint = join(root, 'fixture-daemon.mjs');
  let launched = 0;
  const children = [];
  let recipient;
  await writeFile(entrypoint, `
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
const file = process.argv[2];
const settings = JSON.parse(await readFile(file, 'utf8'));
const state = { listenerId: settings.listenerId, running: true, state: 'running', channelId: settings.channelId, mode: settings.mode, directMessages: settings.directMessages, allServers: settings.allServers, ownerUserId: settings.ownerUserId };
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + settings.controlToken) { response.writeHead(401).end(); return; }
  response.setHeader('content-type', 'application/json');
  if (request.method === 'POST' && request.url === '/stop') {
    state.running = false;
    state.state = 'stopping';
    response.end(JSON.stringify({ ...state, running: false, state: 'stopping' }));
    server.close();
    setTimeout(() => process.exit(0), 50);
  } else response.end(JSON.stringify(state));
});
server.listen(0, '127.0.0.1', async () => {
  settings.controlUrl = 'http://127.0.0.1:' + server.address().port;
  await writeFile(file, JSON.stringify(settings));
});
`);
  const service = {
    accounts: [{ id: 'reader', client: {
      getChannel: async () => ({ id: channelId, guild_id: guildId, type: 0 }),
      createDirectMessageChannel: async (userId) => { recipient = userId; return { id: '200000000000000002', type: 1, recipients: [{ id: userId }] }; },
    } }],
    accountById: () => service.accounts[0],
  };
  const controller = createProactiveController(service, {
    root, entrypoint,
    commandCheck: () => ({ status: 0 }),
    spawnImpl: (...args) => { launched += 1; const child = spawn(...args); children.push(child); return child; },
  });
  try {
    const idle = await controller.status({ channelId });
    assert.equal(idle.state, 'not-started');
    assert.equal(launched, 0);
    const started = await controller.start({ guildId, channelId, model: 'fixture-model' });
    assert.equal(started.running, true);
    assert.equal(started.mode, 'mentions');
    assert.equal(launched, 1);
    await assert.rejects(() => controller.start({ allServers: true }), /Stop active channel listeners/);
    assert.equal((await controller.status({ channelId })).running, true);

    const settings = JSON.parse(await readFile(join(root, `reader-${channelId}.json`), 'utf8'));
    assert.ok(!('controlToken' in started));
    const rejected = await fetch(settings.controlUrl + '/stop', { method: 'POST' });
    assert.equal(rejected.status, 401);
    assert.equal((await controller.start({ guildId, channelId, model: 'fixture-model' })).alreadyRunning, true);
    assert.equal(launched, 1);
    const directMessages = await controller.start({ directMessages: true, ownerUserId: '500000000000000001' });
    assert.equal(directMessages.ownerUserId, directMessageOwnerId);
    assert.equal(recipient, directMessageOwnerId);
    assert.equal(directMessages.mode, 'all');
    assert.equal(directMessages.channelId, '200000000000000002');
    assert.equal((await controller.status({ directMessages: true })).running, true);
    assert.equal((await controller.status({ channelId })).running, true);
    assert.equal((await controller.start({ directMessages: true })).alreadyRunning, true);
    assert.equal(launched, 2);
    const directMessageSettings = JSON.parse(await readFile(directMessagePaths('reader', root).configuration, 'utf8'));
    assert.equal(directMessageSettings.ownerUserId, directMessageOwnerId);
    assert.equal(directMessageSettings.guildId, undefined);
    assert.equal(directMessageSettings.model, 'gpt-6.1-sol');
    assert.equal(directMessageSettings.reasoningEffort, 'low');
    assert.equal(directMessageSettings.serviceTier, 'priority');
    assert.equal(settings.model, 'fixture-model');
    assert.equal((await controller.stop({ directMessages: true })).running, false);
    assert.equal((await controller.status({ channelId })).running, true);
    const stopped = await controller.stop({ channelId });
    assert.equal(stopped.running, false);
    await setTimeout(100);
    assert.equal((await controller.status({ channelId })).running, false);
    const broad = await controller.start({ allServers: true, mode: 'all' });
    assert.equal(broad.allServers, true);
    assert.equal(broad.mode, 'mentions');
    assert.equal(broad.ownerUserId, directMessageOwnerId);
    const broadSettings = JSON.parse(await readFile(serverMentionPaths('reader', root).configuration, 'utf8'));
    assert.equal(broadSettings.channelId, undefined);
    assert.equal(broadSettings.guildId, undefined);
    await assert.rejects(() => controller.start({ guildId, channelId }), /All-server mentions are active/);
    assert.equal((await controller.stop({ allServers: true })).running, false);
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});

test('DM startup rejects a channel for another user before launching a responder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discord-controller-owner-'));
  let launched = 0;
  const service = { accounts: [{ id: 'reader', client: { createDirectMessageChannel: async () => ({ id: channelId, type: 1, recipients: [{ id: '500000000000000001' }] }) } }] };
  service.accountById = () => service.accounts[0];
  const controller = createProactiveController(service, { root, entrypoint: '/fixture/daemon.mjs', spawnImpl: () => { launched += 1; } });
  try {
    await assert.rejects(() => controller.start({ directMessages: true }), /configured owner/);
    assert.equal(launched, 0);
    assert.equal((await controller.status({ directMessages: true })).state, 'not-started');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent start requests cannot launch duplicate channel listeners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discord-controller-lock-'));
  const service = {
    accounts: [{ id: 'reader', client: { getChannel: async () => { await setTimeout(20); throw new Error('Permission check failed'); } } }],
    accountById: () => service.accounts[0],
  };
  const controller = createProactiveController(service, { root, entrypoint: '/fixture/daemon.mjs' });
  try {
    const results = await Promise.allSettled([
      controller.start({ guildId, channelId }), controller.start({ guildId, channelId }),
    ]);
    assert.ok(results.every((result) => result.status === 'rejected'));
    assert.ok(results.some((result) => result.reason.message.includes('already starting')));
    assert.ok(results.some((result) => result.reason.message.includes('Permission check failed')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { writeState } from '../src/proactive/state.mjs';

async function controlledShutdownFixture({ shutdownTimeoutMs = 200, supervisor = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'discord-controller-stop-race-'));
  const livePids = new Set();
  let nextPid = 1000;
  let launches = 0;
  let stopRequests = 0;
  let configuration;
  let state;
  let confirmStop;
  const stopReceived = new Promise((resolve) => { confirmStop = resolve; });
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${configuration?.controlToken}`) { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/stop') {
      stopRequests += 1;
      state = { ...state, running: false, state: 'stopping' };
      response.end(JSON.stringify(state));
      confirmStop();
    } else response.end(JSON.stringify(state));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const service = { accounts: [{ id: 'reader', client: { getChannel: async () => ({ id: channelId, guild_id: guildId, type: 0 }) } }] };
  service.accountById = () => service.accounts[0];
  const controller = createProactiveController(service, {
    root, entrypoint: join(root, 'daemon.mjs'), commandCheck: () => ({ status: 0 }), shutdownTimeoutMs, shutdownPollMs: 2,
    processExistsImpl: (pid) => livePids.has(pid) || pid === process.pid,
    spawnImpl: (command, args) => {
      launches += 1;
      const child = new EventEmitter(); child.pid = ++nextPid; child.unref = () => {};
      livePids.add(child.pid);
      void (async () => {
        configuration = JSON.parse(await readFile(args.at(-1), 'utf8'));
        configuration.pid = child.pid;
        configuration.controlUrl = `http://127.0.0.1:${server.address().port}`;
        state = { listenerId: configuration.listenerId, running: true, state: 'running', accountId: 'reader', channelId, guildId };
        await writeFile(args.at(-1), JSON.stringify(configuration));
        child.emit('spawn');
      })();
      return child;
    },
  });
  const paths = { configuration: join(root, `reader-${channelId}.json`), status: join(root, `reader-${channelId}.status.json`) };
  await controller.start({ guildId, channelId, model: 'preserved-model', batchWindowMs: 500, cooldownMs: 5000 });
  if (supervisor) {
    livePids.add(2000);
    await writeState(`${paths.configuration}.supervision.json`, { enabled: true, pid: 2000 });
  }
  return {
    root, controller, paths, livePids, stopReceived, launches: () => launches, stopRequests: () => stopRequests,
    configuration: () => configuration,
    async close() { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); },
  };
}

test('stop waits for daemon and supervisor exits and rejects an overlapping restart', async () => {
  const fixture = await controlledShutdownFixture({ supervisor: true, shutdownTimeoutMs: 500 });
  try {
    let finished = false;
    const stopping = fixture.controller.stop({ channelId }).then((result) => { finished = true; return result; });
    assert.equal((await fixture.controller.status({ channelId })).state, 'stopping');
    await assert.rejects(fixture.controller.start({ guildId, channelId }), /still stopping/);
    await fixture.stopReceived;
    fixture.livePids.delete(fixture.configuration().pid);
    await setTimeout(5);
    assert.equal(finished, false);
    assert.equal((await fixture.controller.status({ channelId })).state, 'stopping');
    assert.equal(JSON.parse(await readFile(`${fixture.paths.configuration}.supervision.json`, 'utf8')).enabled, false);
    fixture.livePids.delete(2000);
    const stopped = await stopping;
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.shutdownPending, false);
    assert.equal((await fixture.controller.status({ channelId })).state, 'stopped');
    const restarted = await fixture.controller.start({ guildId, channelId, model: 'preserved-model', batchWindowMs: 500, cooldownMs: 5000 });
    assert.equal(restarted.running, true);
    assert.equal(restarted.alreadyRunning, undefined);
    assert.equal(fixture.launches(), 2);
    assert.equal(fixture.configuration().model, 'preserved-model');
    assert.equal(fixture.configuration().batchWindowMs, 500);
    assert.equal(fixture.configuration().cooldownMs, 5000);
  } finally { await fixture.close(); }
});

test('bounded shutdown returns truthful stopping while a registered process remains alive', async () => {
  const fixture = await controlledShutdownFixture({ shutdownTimeoutMs: 20 });
  try {
    const result = await fixture.controller.stop({ channelId });
    assert.equal(result.state, 'stopping');
    assert.equal(result.running, false);
    assert.equal(result.shutdownPending, true);
    assert.equal(fixture.stopRequests(), 1);
    assert.equal((await fixture.controller.status({ channelId })).state, 'stopping');
    await assert.rejects(fixture.controller.start({ guildId, channelId }), /still stopping/);
    assert.equal(fixture.launches(), 1);
    fixture.livePids.delete(fixture.configuration().pid);
    assert.equal((await fixture.controller.status({ channelId })).state, 'stopped');
    assert.equal((await fixture.controller.start({ guildId, channelId })).running, true);
    assert.equal(fixture.launches(), 2);
  } finally { await fixture.close(); }
});

test('already stopped configurations skip shutdown control and process waiting', async () => {
  const fixture = await controlledShutdownFixture({ shutdownTimeoutMs: 200 });
  try {
    fixture.livePids.delete(fixture.configuration().pid);
    const result = await fixture.controller.stop({ channelId });
    assert.equal(result.state, 'stopped');
    assert.equal(result.alreadyStopped, true);
    assert.equal(fixture.stopRequests(), 0);
    assert.equal(fixture.launches(), 1);
  } finally { await fixture.close(); }
});
