import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { fakeCodexServer } from '../test/helpers/codex-app-server.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argumentsList = process.argv.slice(2);
const argument = (name, fallback) => argumentsList.includes(name) ? argumentsList[argumentsList.indexOf(name) + 1] : fallback;
const baseline = argument('--baseline', 'd7ac201');
const samples = Number(argument('--samples', '20'));
const delayMs = Number(argument('--delay-ms', '30'));
if (!Number.isSafeInteger(samples) || samples < 10 || samples > 100 || !Number.isFinite(delayMs) || delayMs < 1 || delayMs > 1000 || !/^[A-Za-z0-9_.\/-]+$/.test(baseline)) throw new Error('Use --samples 10..100, --delay-ms 1..1000 and a valid --baseline Git revision');

const round = (value) => Math.round(value * 10) / 10;
function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { count: sorted.length, p50: round(sorted[Math.ceil(sorted.length * 0.5) - 1]), p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]) };
}
function comparison(before, after, unit) {
  return { unit, before: distribution(before), after: distribution(after), delta: { p50: round(distribution(after).p50 - distribution(before).p50), p95: round(distribution(after).p95 - distribution(before).p95) } };
}

async function measureConversation(sourceRoot, approvedMemory = 'An explicitly approved synthetic memory. '.repeat(300)) {
  const { createConversationReply } = await import(pathToFileURL(join(sourceRoot, 'src/proactive/conversation.mjs')));
  const backend = fakeCodexServer({ delayMs: 1, toolCalls: [{ tool: 'fixture_read' }] });
  const readTools = {
    definitions: [{ type: 'function', name: 'fixture_read', description: 'Synthetic no-side-effect read', inputSchema: { type: 'object', additionalProperties: false } }],
    has: (name) => name === 'fixture_read', errorMessage: (error) => error.message,
    call: async () => ({ success: true, contentItems: [{ type: 'inputText', text: '{"fixture":true}' }] }),
  };
  const respond = createConversationReply({ spawnImpl: backend.spawnImpl, readTools });
  const context = {
    channelId: '200000000000000003', guildId: null, directMessages: true,
    expressions: { emojis: [], stickers: [] }, allowedGifUrls: [], recentMessages: [], triggerMessages: [],
    approvedMemory,
  };
  const firstReplyMs = [];
  const repeatedInputBytes = [];
  const progress = [];
  try {
    await respond(context);
    for (let index = 0; index < samples; index += 1) {
      const startedAt = performance.now();
      let firstResponse;
      await respond(context, undefined, {
        onMessage: async () => { firstResponse ??= performance.now() - startedAt; },
        onProgress: () => { const operation = wait(delayMs); progress.push(operation); return operation; },
      });
      if (firstResponse === undefined) throw new Error('Synthetic backend did not publish a reply');
      firstReplyMs.push(firstResponse);
      const lastRequest = backend.requests.filter((request) => request.method === 'turn/start').at(-1);
      repeatedInputBytes.push(Buffer.byteLength(lastRequest.params.input.find((item) => item.type === 'text').text));
    }
    await Promise.allSettled(progress);
    assert.equal(backend.toolResponses.length, samples + 1, 'Both versions must execute the same warmup and measured reads');
    assert.ok(backend.toolResponses.every((response) => response.result.success), 'Rejected fixture tools invalidate a timing comparison');
    assert.ok(progress.length >= samples, 'Tool activity must remain observable despite asynchronous progress');
  } finally { await respond.close(); }
  return { firstReplyMs, repeatedInputBytes };
}

async function measureScheduler(sourceRoot) {
  const { createReplyScheduler } = await import(pathToFileURL(join(sourceRoot, 'src/proactive/reply-scheduler.mjs')));
  const independentLaneWaitMs = [];
  for (let index = 0; index < samples; index += 1) {
    const schedule = createReplyScheduler({ cooldownMs: 0, maxRepliesPerMinute: 1000, maxConcurrent: 2 });
    let releaseStarted;
    const started = new Promise((resolve) => { releaseStarted = resolve; });
    const slow = schedule(async () => { releaseStarted(); await wait(delayMs); }, undefined, { conversationKey: 'channel-a' });
    await started;
    const began = performance.now();
    const fast = schedule(() => { independentLaneWaitMs.push(performance.now() - began); }, undefined, { conversationKey: 'channel-b' });
    await Promise.all([slow, fast]);
  }
  return independentLaneWaitMs;
}

const scratch = await mkdtemp(join(tmpdir(), 'nova-harness-benchmark-'));
try {
  const { stdout: revision } = await execute('git', ['rev-parse', '--verify', '--end-of-options', `${baseline}^{commit}`], { cwd: root });
  const archive = join(scratch, 'baseline.tar');
  await execute('git', ['archive', '--format=tar', `--output=${archive}`, revision.trim()], { cwd: root });
  await execute('tar', ['-xf', archive, '-C', scratch]);
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const beforeConversation = await measureConversation(scratch);
  const afterConversation = await measureConversation(root);
  const beforeSmallConversation = await measureConversation(scratch, '');
  const afterSmallConversation = await measureConversation(root, '');
  const beforeScheduler = await measureScheduler(scratch);
  const afterScheduler = await measureScheduler(root);
  process.stdout.write(JSON.stringify({
    kind: 'synthetic-harness-comparison', baseline: revision.trim(), samples, simulatedProgressDelayMs: delayMs,
    methodology: 'Actual archived baseline and current working-tree modules use the same in-process fake backend. Warm workers; no Discord network, external model, or quota. Negative deltas mean reductions. Timers measure simulated callback/queue waits; input bytes are measured serialized turn input, not billed tokens.',
    slowProgressFirstReply: comparison(beforeConversation.firstReplyMs, afterConversation.firstReplyMs, 'ms'),
    independentConversationQueueWait: comparison(beforeScheduler, afterScheduler, 'ms'),
    repeatedStableContext: comparison(beforeConversation.repeatedInputBytes, afterConversation.repeatedInputBytes, 'bytes'),
    shortStableContext: comparison(beforeSmallConversation.repeatedInputBytes, afterSmallConversation.repeatedInputBytes, 'bytes'),
  }, null, 2) + '\n');
} finally { await rm(scratch, { recursive: true, force: true }); }
