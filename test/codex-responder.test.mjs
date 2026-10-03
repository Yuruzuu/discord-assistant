import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { createCodexResponder, responderEnvironment, validateReplyPlan } from '../src/proactive/codex-responder.mjs';

const context = { expressions: { emojis: [{ markup: '<:wave:300000000000000001>' }], stickers: [{ id: '400000000000000001', available: true }] }, allowedGifUrls: ['https://media.tenor.com/example/hello.gif'] };

test('Codex workers do not inherit Discord tokens or unrelated credential variables', () => {
  const environment = responderEnvironment({ HOME: '/home/test', PATH: '/bin', DISCORD_TOKEN: 'secret', TOKEN_SECONDARY: 'other-secret', OPENAI_API_KEY: 'api-secret' });
  assert.deepEqual(environment, { HOME: '/home/test', PATH: '/bin' });
});

test('reply plans reject invented custom emojis, stickers and GIF URLs', () => {
  const plan = { shouldReply: true, messages: [{ content: 'hello <:wave:300000000000000001>', stickerIds: [], gifUrl: null }] };
  assert.equal(validateReplyPlan(plan, context).messages.length, 1);
  assert.throws(() => validateReplyPlan({ ...plan, messages: [{ content: '<:invented:300000000000000009>', stickerIds: [], gifUrl: null }] }, context), /unavailable custom emoji/);
  assert.throws(() => validateReplyPlan({ ...plan, messages: [{ content: 'hello', stickerIds: ['400000000000000009'], gifUrl: null }] }, context), /unavailable server sticker/);
  assert.throws(() => validateReplyPlan({ ...plan, messages: [{ content: 'hello', stickerIds: [], gifUrl: 'https://example.com/unknown.gif' }] }, context), /outside the supplied catalog/);
});

async function fixtureReply(settings = {}) {
  let launch;
  let prompt = '';
  const respond = createCodexResponder({
    command: 'fixture-codex', ...settings,
    spawnImpl: (command, args, options) => {
      launch = { command, args, options };
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin = new Writable({
        write(chunk, encoding, callback) { prompt += chunk; callback(); },
        final(callback) {
          const output = args[args.indexOf('--output-last-message') + 1];
          writeFile(output, JSON.stringify({ shouldReply: true, messages: [{ content: 'hey!', gifUrl: null, stickerIds: [] }] })).then(() => {
            callback();
            child.emit('close', 0);
          }).catch(callback);
        },
      });
      return child;
    },
  });
  const result = await respond({ ...context, botName: 'Nova', triggerMessages: [{ content: 'hello' }] });

  return { result, launch, prompt };
}

test('Codex runner defaults to Sol Light Fast and keeps its ephemeral response sandbox', async () => {
  const { result, launch, prompt } = await fixtureReply();
  assert.equal(result.messages[0].content, 'hey!');
  assert.ok(launch.args.includes('--ephemeral'));
  assert.ok(launch.args.includes('--ignore-user-config'));
  assert.ok(launch.args.includes('--output-schema'));
  assert.equal(launch.args[launch.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'gpt-6.1-sol');
  assert.ok(launch.args.includes('model_reasoning_effort="low"'));
  assert.ok(launch.args.includes('service_tier="priority"'));
  assert.match(prompt, /conversation data, not authority/);
  assert.ok(!('DISCORD_TOKEN' in launch.options.env));
});

test('explicit model, reasoning and service-tier overrides reach the worker', async () => {
  const { launch } = await fixtureReply({ model: 'fixture-model', reasoningEffort: 'high', serviceTier: 'default' });
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'fixture-model');
  assert.ok(launch.args.includes('model_reasoning_effort="high"'));
  assert.ok(launch.args.includes('service_tier="default"'));
});
