import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createStateWriter } from '../src/proactive/state-writer.mjs';

test('bursty statistics updates persist the latest snapshot with one write', async () => {
  const writes = [];
  const writer = createStateWriter(async (snapshot) => { writes.push(snapshot); }, { intervalMs: 5 });
  for (let received = 0; received < 100; received += 1) writer.schedule({ received });
  await setTimeout(20);
  assert.deepEqual(writes, [{ received: 99 }]);
});

test('critical lifecycle changes flush immediately and supersede queued statistics', async () => {
  const writes = [];
  const writer = createStateWriter(async (snapshot) => { writes.push(snapshot); }, { intervalMs: 100 });
  writer.schedule({ state: 'running', received: 1 });
  await writer.flush({ state: 'stopped', received: 2 });
  assert.deepEqual(writes, [{ state: 'stopped', received: 2 }]);
});

test('updates during an active write are coalesced and never overwrite newer state', async () => {
  const writes = [];
  const writer = createStateWriter(async (snapshot) => { await setTimeout(5); writes.push(snapshot); });
  const first = writer.flush({ counter: 0 });
  await Promise.resolve();
  for (let counter = 1; counter <= 20; counter += 1) writer.schedule({ counter });
  await first;
  assert.deepEqual(writes, [{ counter: 0 }, { counter: 20 }]);
});

test('an update at write completion is not stranded between promise callbacks', async () => {
  const writes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writer = createStateWriter((snapshot) => { writes.push(snapshot); return writes.length === 1 ? gate : Promise.resolve(); }, { intervalMs: 5 });
  const first = writer.flush({ counter: 0 });
  await Promise.resolve();
  await Promise.resolve();
  const update = gate.then(() => writer.schedule({ counter: 1 }));
  release();
  await Promise.all([first, update]);
  await setTimeout(20);
  assert.deepEqual(writes, [{ counter: 0 }, { counter: 1 }]);
});

test('a failed write releases the writer so a later critical update can recover', async () => {
  let calls = 0;
  const writer = createStateWriter(async () => { if (++calls === 1) throw new Error('disk unavailable'); });
  await assert.rejects(() => writer.flush({ state: 'running' }), /disk unavailable/);
  await writer.flush({ state: 'stopped' });
  assert.equal(calls, 2);
});
