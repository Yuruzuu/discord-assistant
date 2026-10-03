import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createProactiveController } from '../src/proactive/controller.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';

test('listener starts only on request, survives its caller, and stops through authenticated control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discord-controller-'));
  const entrypoint = join(root, 'fixture-daemon.mjs');
  let launched = 0;
  let child;
  await writeFile(entrypoint, `
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
const file = process.argv[2];
const settings = JSON.parse(await readFile(file, 'utf8'));
const state = { listenerId: settings.listenerId, running: true, state: 'running', channelId: settings.channelId, mode: settings.mode };
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
    accounts: [{ id: 'reader', client: { getChannel: async () => ({ id: channelId, guild_id: guildId, type: 0 }) } }],
    accountById: () => service.accounts[0],
  };
  const controller = createProactiveController(service, {
    root, entrypoint,
    commandCheck: () => ({ status: 0 }),
    spawnImpl: (...args) => { launched += 1; child = spawn(...args); return child; },
  });
  try {
    const idle = await controller.status({ channelId });
    assert.equal(idle.state, 'not-started');
    assert.equal(launched, 0);
    const started = await controller.start({ guildId, channelId, model: 'fixture-model' });
    assert.equal(started.running, true);
    assert.equal(started.mode, 'mentions');
    assert.equal(launched, 1);
    assert.equal((await controller.status({ channelId })).running, true);

    const settings = JSON.parse(await readFile(join(root, `reader-${channelId}.json`), 'utf8'));
    assert.ok(!('controlToken' in started));
    const rejected = await fetch(settings.controlUrl + '/stop', { method: 'POST' });
    assert.equal(rejected.status, 401);
    assert.equal((await controller.start({ guildId, channelId, model: 'fixture-model' })).alreadyRunning, true);
    assert.equal(launched, 1);
    const stopped = await controller.stop({ channelId });
    assert.equal(stopped.running, false);
    await setTimeout(100);
    assert.equal((await controller.status({ channelId })).running, false);
  } finally {
    child?.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
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
