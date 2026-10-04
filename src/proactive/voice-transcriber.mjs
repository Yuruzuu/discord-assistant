import { access, mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function audioExtension(attachment) {
  let filename = attachment.filename || attachment.name || '';
  if (!filename) { try { filename = new URL(attachment.url).pathname; } catch {} }
  return /\.(ogg|opus|wav|mp3|m4a|mp4|flac|aiff|aif|webm)$/i.test(filename);
}

export function isVoiceAttachment(attachment) {
  return /^audio\//.test(attachment.content_type || attachment.type || '') || audioExtension(attachment) || Boolean(attachment.waveform) || Number(attachment.duration_secs ?? attachment.duration) > 0;
}

function supportedAudioHeader(audio) {
  const start = audio.subarray(0, 4).toString('ascii');
  return ['OggS', 'fLaC', 'FORM'].includes(start) || (start === 'RIFF' && audio.subarray(8, 12).toString('ascii') === 'WAVE') || audio.subarray(0, 3).toString('ascii') === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) || audio.subarray(4, 8).toString('ascii') === 'ftyp' || audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

async function downloadAudio(attachment, signal, fetchImpl) {
  let url = new URL(attachment.url);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (url.protocol !== 'https:' || url.username || url.password || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || (url.port && url.port !== '443')) throw new Error('Voice attachment must be hosted on approved Discord media');
    const response = await fetchImpl(url, { signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); const destination = response.headers.get('location');
      if (!destination) throw new Error('Voice attachment redirect has no destination');
      url = new URL(destination, url); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Voice attachment returned HTTP ${response.status}`); }
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    if (!mimeType.startsWith('audio/') && !(audioExtension(attachment) && ['', 'application/octet-stream'].includes(mimeType))) { await response.body?.cancel(); throw new Error('Voice attachment is not audio'); }
    if (Number(response.headers.get('content-length')) > 16 * 1024 * 1024) { await response.body?.cancel(); throw new Error('Voice attachment exceeds 16 MiB'); }
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      for (;;) { signal?.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 16 * 1024 * 1024) throw new Error('Voice attachment exceeds 16 MiB'); chunks.push(value); }
      const audio = Buffer.concat(chunks);
      if (!supportedAudioHeader(audio)) throw new Error('Voice attachment has an unsupported audio container');
      return audio;
    } finally { await reader.cancel(); }
  }
  throw new Error('Voice attachment redirected too many times');
}

async function availableFile(value, executable = false) {
  if (!value || !path.isAbsolute(value)) return false;
  try { await access(value, executable ? constants.X_OK : constants.R_OK); return true; } catch { return false; }
}

function runCommand(command, argumentsValue, directory, signal, spawnImpl) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawnImpl(command, argumentsValue, {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', TMPDIR: directory, LANG: 'en_US.UTF-8' },
    });
    let forceTermination; let failure;
    const cancel = () => { child.kill(); forceTermination = setTimeout(() => child.kill('SIGKILL'), 1000); forceTermination.unref?.(); };
    signal?.addEventListener('abort', cancel, { once: true });
    let output = ''; let diagnostic = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 200000) { failure = new Error('Voice backend output exceeded its limit'); child.kill('SIGKILL'); } });
    child.stderr.on('data', (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-500); });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', cancel); clearTimeout(forceTermination);
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === 0) resolve(output.trim().slice(0, 20000));
      else reject(new Error(`Voice backend failed (${code}): ${diagnostic}`));
    });
    if (signal?.aborted) cancel();
  });
}

export function createVoiceTranscriber(configuration = {}, { fetchImpl = fetch, spawnImpl = spawn, environment = process.env } = {}) {
  const kind = configuration.backend || configuration.kind || 'disabled';
  const timeoutMs = Math.min(300000, Math.max(1000, configuration.timeoutMs || 120000));
  async function status() {
    if (kind === 'disabled') return { backend: kind, available: false, reason: 'Select a local whisper-cli executable and model, or explicitly configure a speech API.' };
    if (kind === 'local') {
      if (!await availableFile(configuration.executable, true)) return { backend: kind, available: false, reason: 'Configured whisper-cli executable is missing or not executable.' };
      if (!await availableFile(configuration.model)) return { backend: kind, available: false, reason: 'Configured local speech model is missing or unreadable.' };
      if (configuration.ffmpeg && !await availableFile(configuration.ffmpeg, true)) return { backend: kind, available: false, reason: 'Configured ffmpeg executable is missing or not executable.' };
      return { backend: kind, available: true, conversionAvailable: Boolean(configuration.ffmpeg) };
    }
    if (kind === 'api') {
      try {
        const endpoint = new URL(configuration.endpoint);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error();
      } catch { return { backend: kind, available: false, reason: 'Speech API requires a configured HTTPS endpoint without URL credentials.' }; }
      if (!configuration.apiKeyEnv || !environment[configuration.apiKeyEnv]) return { backend: kind, available: false, reason: 'Configured speech API key environment variable is unavailable.' };
      if (!configuration.model) return { backend: kind, available: false, reason: 'Speech API model must be explicitly selected.' };
      return { backend: kind, available: true, externalBilling: true };
    }
    return { backend: kind, available: false, reason: 'Unknown speech backend. Use disabled, local or api.' };
  }
  const transcribe = async (attachment, suppliedSignal) => {
    // Also accepts the context adapter's { signal } convention.
    const signal = suppliedSignal?.signal || suppliedSignal;
    const signalValue = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    signalValue.throwIfAborted();
    const readiness = await status(); if (!readiness.available) throw new Error(readiness.reason);
    const audio = await downloadAudio(attachment, signalValue, fetchImpl);
    if (kind === 'api') {
      const body = new FormData();
      body.append('file', new Blob([audio], { type: attachment.content_type || 'audio/ogg' }), 'voice.ogg'); body.append('model', configuration.model); body.append('response_format', 'json');
      const response = await fetchImpl(configuration.endpoint, { method: 'POST', redirect: 'error', signal: signalValue, headers: { Authorization: `Bearer ${environment[configuration.apiKeyEnv]}` }, body });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Speech API returned HTTP ${response.status}`); }
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 256 * 1024) throw new Error('Speech API response exceeded its limit'); chunks.push(value); }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof result.text !== 'string') throw new Error('Speech API returned no transcript text');
        return result.text.slice(0, 20000);
      } finally { await reader.cancel(); }
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nova-voice-'));
    try {
      const input = path.join(directory, 'voice.ogg'); await writeFile(input, audio, { mode: 0o600 });
      let source = input;
      if (configuration.ffmpeg) {
        source = path.join(directory, 'voice.wav');
        await runCommand(configuration.ffmpeg, ['-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', source], directory, signalValue, spawnImpl);
      } else if (!/^audio\/(wav|x-wav)$/.test(attachment.content_type || '')) throw new Error('Discord voice notes require a configured ffmpeg executable to convert Opus audio for whisper-cli.');
      const output = path.join(directory, 'transcript');
      await runCommand(configuration.executable, ['-m', configuration.model, '-f', source, '-otxt', '-of', output, '-nt'], directory, signalValue, spawnImpl);
      if ((await stat(`${output}.txt`)).size > 200000) throw new Error('Local transcript exceeded its limit');
      const text = await readFile(`${output}.txt`, 'utf8');
      if (text.length > 200000) throw new Error('Local transcript exceeded its limit');
      return text.trim().slice(0, 20000);
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
  transcribe.status = status;
  return transcribe;
}
