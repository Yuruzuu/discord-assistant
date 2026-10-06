import { performance } from 'node:perf_hooks';

const percentile = (values, fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)] || 0;
const rounded = (value) => Math.round(value * 10) / 10;

// Only numeric timing and counters are retained; never prompts, arguments, results or raw errors.
export function createStageMetrics({ now = () => performance.now(), sampleLimit = 128, stageLimit = 48 } = {}) {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 1024 || !Number.isInteger(stageLimit) || stageLimit < 1 || stageLimit > 128) throw new Error('Metric limits must be bounded positive integers');
  const stages = new Map();
  const counters = new Map();
  function record(stage, elapsedMs) {
    if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(stage || '') || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    if (!stages.has(stage) && stages.size >= stageLimit) return;
    const entry = stages.get(stage) || { count: 0, totalMs: 0, maxMs: 0, samples: [] };
    entry.count += 1; entry.totalMs += elapsedMs; entry.maxMs = Math.max(entry.maxMs, elapsedMs);
    entry.samples.push(elapsedMs); if (entry.samples.length > sampleLimit) entry.samples.shift();
    stages.set(stage, entry);
  }
  function start(stage) { const began = now(); let finished = false; return () => { if (!finished) { finished = true; record(stage, Math.max(0, now() - began)); } }; }
  async function measure(stage, operation) { const stop = start(stage); try { return await operation(); } finally { stop(); } }
  function count(name, value = 1) {
    if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(name || '') || !Number.isFinite(value) || value < 0 || (!counters.has(name) && counters.size >= stageLimit)) return;
    counters.set(name, (counters.get(name) || 0) + value);
  }
  function snapshot() {
    return { sampleLimit, stages: Object.fromEntries([...stages].map(([name, entry]) => {
      const samples = [...entry.samples].sort((a, b) => a - b);
      return [name, { count: entry.count, samples: samples.length, lastMs: rounded(entry.samples.at(-1)), averageMs: rounded(entry.totalMs / entry.count), p50Ms: rounded(percentile(samples, 0.5)), p95Ms: rounded(percentile(samples, 0.95)), maxMs: rounded(entry.maxMs) }];
    })), counters: Object.fromEntries(counters) };
  }
  return { record, start, measure, count, snapshot, now };
}
