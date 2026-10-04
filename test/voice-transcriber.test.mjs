import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, chmod, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createVoiceTranscriber } from '../src/proactive/voice-transcriber.mjs';

const attachment = { url: 'https://cdn.discordapp.com/attachments/voice.ogg', content_type: 'audio/ogg' };
const audio = () => new Response(Buffer.from('OggSfixture'), { headers: { 'content-type': 'audio/ogg' } });

test('speech is disabled until chosen and missing local prerequisites are actionable', async () => {
  const disabled = createVoiceTranscriber();
  assert.equal((await disabled.status()).available, false);
  await assert.rejects(disabled(attachment), /Select a local/);
  const missing = createVoiceTranscriber({ backend: 'local', executable: '/missing/whisper', model: '/missing/model' });
  assert.match((await missing.status()).reason, /executable/);
});

test('local whisper conversion uses private temporary files and cleans them after completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-test-')); let temporary;
  try {
    const executable = path.join(root, 'whisper'); const model = path.join(root, 'model'); const ffmpeg = path.join(root, 'ffmpeg');
    for (const target of [executable, model, ffmpeg]) { await writeFile(target, 'fixture'); await chmod(target, 0o700); }
    const calls = [];
    const spawnImpl = (command, args, options) => {
      calls.push({ command, args, options }); temporary = options.cwd;
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      process.nextTick(async () => {
        if (command === executable) await writeFile(`${args[args.indexOf('-of') + 1]}.txt`, 'hello from voice');
        child.emit('close', 0);
      });
      return child;
    };
    const voice = createVoiceTranscriber({ backend: 'local', executable, model, ffmpeg }, { spawnImpl, fetchImpl: async () => audio() });
    assert.equal((await voice.status()).available, true);
    assert.equal(await voice(attachment), 'hello from voice');
    assert.equal(calls.length, 2); assert.ok(calls[0].args.includes('-nostdin'));
    assert.deepEqual(Object.keys(calls[1].options.env).sort(), ['LANG', 'PATH', 'TMPDIR']);
    await assert.rejects(access(temporary));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('speech API posts only to explicit endpoint and never forwards authorization to audio CDN', async () => {
  const requests = [];
  const voice = createVoiceTranscriber({ backend: 'api', endpoint: 'https://speech.example/transcriptions', apiKeyEnv: 'VOICE_KEY', model: 'chosen-model' }, {
    environment: { VOICE_KEY: 'fixture-token' },
    fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return options.method === 'POST' ? Response.json({ text: 'hello' }) : audio(); },
  });
  assert.equal((await voice.status()).externalBilling, true);
  assert.equal(await voice(attachment), 'hello');
  assert.equal(requests[0].options.headers, undefined);
  assert.equal(requests[1].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(requests[1].options.redirect, 'error');
  assert.ok(!JSON.stringify(await voice.status()).includes('fixture-token'));
});

test('voice audio rejects foreign redirects and oversized data without sending provider requests', async () => {
  let calls = 0;
  const voice = createVoiceTranscriber({ backend: 'api', endpoint: 'https://speech.example', apiKeyEnv: 'KEY', model: 'chosen' }, {
    environment: { KEY: 'private' }, fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: 'https://evil.example/audio' } }); },
  });
  await assert.rejects(voice(attachment), /approved Discord media/); assert.equal(calls, 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(voice(attachment, cancelled.signal), { name: 'AbortError' });
});

test('generic Discord CDN audio requires a recognized extension and supported container', async () => {
  const configuration = { backend: 'api', endpoint: 'https://speech.example', apiKeyEnv: 'KEY', model: 'chosen' };
  const voice = createVoiceTranscriber(configuration, { environment: { KEY: 'private' }, fetchImpl: async (_url, options) => options.method === 'POST' ? Response.json({ text: 'decoded' }) : new Response(Buffer.from('OggSfixture'), { headers: { 'content-type': 'application/octet-stream' } }) });
  assert.equal(await voice({ ...attachment, content_type: undefined }), 'decoded');
  await assert.rejects(voice({ url: 'https://cdn.discordapp.com/download', waveform: 'wave' }), /not audio/);
  const invalid = createVoiceTranscriber(configuration, { environment: { KEY: 'private' }, fetchImpl: async () => new Response('#EXTM3U\nhttps://evil.example/file', { headers: { 'content-type': 'audio/ogg' } }) });
  await assert.rejects(invalid(attachment), /unsupported audio container/);
});

test('abort waits for decoder close before removing private audio files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-abort-')); let temporary; let filesExistedBeforeClose = false;
  try {
    const executable = path.join(root, 'whisper'); const model = path.join(root, 'model'); const ffmpeg = path.join(root, 'ffmpeg');
    for (const target of [executable, model, ffmpeg]) { await writeFile(target, 'fixture'); await chmod(target, 0o700); }
    const cancellation = new AbortController();
    const voice = createVoiceTranscriber({ backend: 'local', executable, model, ffmpeg }, {
      fetchImpl: async () => audio(), spawnImpl: (_command, args, options) => {
        temporary = options.cwd;
        assert.ok(args.includes('file,pipe')); assert.ok(args.includes('pcm_s16le'));
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { setTimeout(async () => { try { await access(path.join(temporary, 'voice.ogg')); filesExistedBeforeClose = true; } catch {} child.emit('close', null); }, 10); };
        process.nextTick(() => cancellation.abort());
        return child;
      },
    });
    await assert.rejects(voice(attachment, cancellation.signal), { name: 'AbortError' });
    assert.equal(filesExistedBeforeClose, true); await assert.rejects(access(temporary));
  } finally { await rm(root, { recursive: true, force: true }); }
});
