import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppServer } from '../src/proactive/app-server.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

test('concurrent transport shutdown reuses one close operation and terminates the child once', async () => {
  const fixture = fakeCodexServer({ closeDelayMs: 10 });
  const server = createAppServer({ command: 'fixture', spawnImpl: fixture.spawnImpl });
  let kills = 0;
  const kill = fixture.children[0].kill;
  fixture.children[0].kill = (...args) => { kills += 1; return kill(...args); };
  const first = server.close();
  const second = server.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await server.close();
  assert.equal(kills, 1);
});

test('an already exited worker does not incur the shutdown timeout or another signal', async () => {
  const fixture = fakeCodexServer();
  const server = createAppServer({ command: 'fixture', spawnImpl: fixture.spawnImpl });
  const child = fixture.children[0];
  child.signalCode = 'SIGTERM';
  child.emit('close', null);
  let kills = 0;
  child.kill = () => { kills += 1; };
  let closed = false;
  const closing = server.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, true);
  await closing;
  assert.equal(kills, 0);
});
