import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeTurn } from '../src/proactive/native-turn.mjs';

test('native completion requires the exact bound identity and a terminal status', async () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const turn = createNativeTurn();
    turn.bind('turn-owned');
    assert.equal(turn.observe({ id: 'other-turn', status }), null);
    assert.equal(turn.outcome(), undefined);
    assert.equal(turn.observe({ id: 'turn-owned', status: 'inProgress' }), null);
    assert.deepEqual(turn.observe({ id: 'turn-owned', status }), { id: 'turn-owned', status });
    assert.deepEqual(await turn.terminal, { id: 'turn-owned', status });
    assert.equal(turn.id(), 'turn-owned');
  }
});

test('early terminal notifications settle only after the matching start identity binds', async () => {
  const turn = createNativeTurn();
  assert.equal(turn.observe({ id: 'unrelated', status: 'failed' }), null);
  assert.equal(turn.observe({ id: 'owned', status: 'completed' }), null);
  assert.equal(turn.outcome(), undefined);
  turn.bind('owned');
  assert.deepEqual(await turn.wait(10), { id: 'owned', status: 'completed' });
});

test('malformed completion events do not confirm settlement', async () => {
  const turn = createNativeTurn();
  turn.bind('owned');
  for (const value of [null, {}, { id: null, status: 'completed' }, { id: 'owned' }, { id: 'owned', status: 'unknown' }, { id: 'other', status: 'completed' }]) assert.equal(turn.observe(value), null);
  assert.equal(await turn.wait(10), null);
  assert.equal(turn.outcome(), undefined);
});

test('native identity changes and missing identities are fatal protocol errors', () => {
  const turn = createNativeTurn();
  for (const value of [null, undefined, '', 1, 'x'.repeat(201)]) assert.throws(() => turn.bind(value), { code: 'NOVA_NATIVE_PROTOCOL', novaFatal: true });
  turn.bind('owned');
  assert.throws(() => turn.bind('different'), { code: 'NOVA_NATIVE_PROTOCOL', novaFatal: true });
  assert.doesNotThrow(() => turn.bind('owned'));
});

test('the first confirmed native terminal outcome cannot be overwritten', async () => {
  const turn = createNativeTurn();
  turn.bind('owned');
  turn.observe({ id: 'owned', status: 'interrupted' });
  turn.observe({ id: 'owned', status: 'completed' });
  assert.deepEqual(await turn.wait(10), { id: 'owned', status: 'interrupted' });
});

test('early notification retention is bounded and a late matching completion can still settle', async () => {
  const turn = createNativeTurn();
  for (let index = 0; index < 5; index += 1) turn.observe({ id: `early-${index}`, status: 'completed' });
  turn.bind('early-0');
  assert.equal(await turn.wait(5), null);
  turn.observe({ id: 'early-0', status: 'failed' });
  assert.deepEqual(await turn.terminal, { id: 'early-0', status: 'failed' });
});

test('early duplicate terminals preserve the first confirmation before admission binds', async () => {
  const turn = createNativeTurn();
  turn.observe({ id: 'owned', status: 'interrupted' });
  turn.observe({ id: 'owned', status: 'completed' });
  turn.bind('owned');
  assert.deepEqual(await turn.terminal, { id: 'owned', status: 'interrupted' });
});
