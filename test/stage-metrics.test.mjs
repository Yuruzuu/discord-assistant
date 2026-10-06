import assert from 'node:assert/strict';
import test from 'node:test';
import { createStageMetrics } from '../src/proactive/stage-metrics.mjs';

test('stage measurements retain bounded recent samples and all-time counts and maxima', () => {
  const metrics = createStageMetrics({ sampleLimit: 3 });
  for (const value of [100, 1, 3, 2]) metrics.record('delivery', value);
  assert.deepEqual(metrics.snapshot().stages.delivery, { count: 4, samples: 3, lastMs: 2, averageMs: 26.5, p50Ms: 2, p95Ms: 3, maxMs: 100 });
  const first = metrics.snapshot();
  first.stages.delivery.count = -1;
  assert.equal(metrics.snapshot().stages.delivery.count, 4);
});

test('timing stop is idempotent and measure preserves return values and failures', async () => {
  let time = 100;
  const metrics = createStageMetrics({ now: () => time });
  const stop = metrics.start('worker_start');
  time = 110.24; stop(); stop();
  assert.equal(metrics.snapshot().stages.worker_start.lastMs, 10.2);
  assert.equal(metrics.snapshot().stages.worker_start.count, 1);
  const value = await metrics.measure('tool', async () => { time += 5; return 'result'; });
  assert.equal(value, 'result');
  const failure = new Error('sensitive content must never be retained');
  await assert.rejects(metrics.measure('tool', async () => { time += 8; throw failure; }), (error) => error === failure);
  assert.equal(metrics.snapshot().stages.tool.count, 2);
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('sensitive'));
});

test('invalid names and values are refused and stage/counter registries remain bounded', () => {
  const metrics = createStageMetrics({ stageLimit: 2 });
  for (const name of ['private contents', 'UPPER', 'https://example.com', '', 'x'.repeat(81)]) { metrics.record(name, 1); metrics.count(name); }
  for (const invalid of [-1, Infinity, NaN, '2']) { metrics.record('invalid', invalid); metrics.count('invalid', invalid); }
  metrics.record('first', 0); metrics.record('second', 2); metrics.record('third', 3); metrics.record('first', 1);
  metrics.count('input_bytes', 10); metrics.count('input_bytes', 2); metrics.count('tool_calls'); metrics.count('excess');
  assert.deepEqual(Object.keys(metrics.snapshot().stages), ['first', 'second']);
  assert.deepEqual(metrics.snapshot().counters, { input_bytes: 12, tool_calls: 1 });
  assert.equal(metrics.snapshot().stages.first.count, 2);
});

test('percentiles use nearest ranks and negative elapsed clock movement clamps to zero', () => {
  let time = 20;
  const metrics = createStageMetrics({ now: () => time });
  const stop = metrics.start('clock'); time = 10; stop();
  assert.equal(metrics.snapshot().stages.clock.lastMs, 0);
  for (let value = 1; value <= 20; value += 1) metrics.record('turn', value);
  assert.equal(metrics.snapshot().stages.turn.p50Ms, 10);
  assert.equal(metrics.snapshot().stages.turn.p95Ms, 19);
});

test('sample and stage limits reject invalid or excessive configuration', () => {
  for (const sampleLimit of [0, -1, 1.5, 1025, Infinity, NaN]) assert.throws(() => createStageMetrics({ sampleLimit }), /bounded positive integers/);
  for (const stageLimit of [0, -1, 1.5, 129, Infinity, NaN]) assert.throws(() => createStageMetrics({ stageLimit }), /bounded positive integers/);
});
