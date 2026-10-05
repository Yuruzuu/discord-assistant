import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { reportPreparation } from './context-media.mjs';

const maximumBytes = 16 * 1024 * 1024;
const sourceWorker = typeof __dirname === 'string' ? path.join(__dirname, 'pdf-worker.mjs') : fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url));

export function isPdfAttachment(attachment) {
  return /^application\/pdf(?:;|$)/i.test(attachment.content_type || attachment.type || '') || /\.pdf$/i.test(attachment.filename || attachment.name || '');
}

async function downloadPdf(attachment, signal, fetchImpl) {
  if (Number(attachment.size) > maximumBytes) throw new Error('PDF exceeds 16 MiB');
  let url;
  try { url = new URL(attachment.url); } catch { throw new Error('PDF attachment has no valid download URL'); }
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    signal.throwIfAborted();
    if (url.protocol !== 'https:' || url.username || url.password || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || (url.port && url.port !== '443')) throw new Error('PDF attachments must be hosted on approved Discord media');
    const response = await fetchImpl(url, { signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); const location = response.headers.get('location');
      if (!location) throw new Error('PDF attachment redirect has no destination');
      url = new URL(location, url); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`PDF attachment returned HTTP ${response.status}`); }
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['application/pdf', 'application/octet-stream'].includes(mimeType)) { await response.body?.cancel(); throw new Error('Attachment response is not a PDF'); }
    if (Number(response.headers.get('content-length')) > maximumBytes) { await response.body?.cancel(); throw new Error('PDF exceeds 16 MiB'); }
    if (!response.body) throw new Error('PDF attachment response has no body');
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maximumBytes) throw new Error('PDF exceeds 16 MiB'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    if (!/^%PDF-\d\.\d/.test(bytes.subarray(0, 16).toString('ascii'))) throw new Error('Attachment does not have a valid PDF signature');
    return bytes;
  }
  throw new Error('PDF attachment redirected too many times');
}

function extractPdf(input, directory, settings, signal, spawnImpl, workerPath) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawnImpl(process.execPath, ['--max-old-space-size=192', workerPath, input, String(settings.startPage), String(settings.maxPages), String(settings.maxCharacters), String(settings.maxRenderedPages)], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '/usr/bin:/bin', TMPDIR: directory, LANG: 'en_US.UTF-8' },
    });
    const chunks = []; let bytes = 0; let failure; let diagnostic = ''; let forceTermination;
    const cancel = () => { child.kill(); forceTermination = setTimeout(() => child.kill('SIGKILL'), 500); forceTermination.unref?.(); };
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 9 * 1024 * 1024) { failure = new Error('PDF extraction exceeded its output limit'); child.kill('SIGKILL'); } else chunks.push(chunk); });
    child.stderr.on('data', (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-1000); });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      signal.removeEventListener('abort', cancel); clearTimeout(forceTermination);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(diagnostic.includes('PDF is password protected') ? 'PDF is password protected' : 'PDF could not be safely parsed or rendered'));
      else { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('PDF reader returned invalid output')); } }
    });
    if (signal.aborted) cancel();
  });
}

export async function readPdfAttachment(attachment, { startPage = 1, maxPages = 12, maxCharacters = 40000, maxRenderedPages = 3, timeoutMs = 30000, signal, fetchImpl = fetch, spawnImpl = spawn, workerPath = sourceWorker } = {}) {
  if (!isPdfAttachment(attachment)) throw new Error('Select a PDF attachment from a readable Discord message');
  for (const [name, value, maximum] of [['startPage', startPage, 300], ['maxPages', maxPages, 20], ['maxCharacters', maxCharacters, 80000], ['maxRenderedPages', maxRenderedPages, 3]]) {
    if (!Number.isInteger(value) || value < (name === 'maxRenderedPages' ? 0 : 1) || value > maximum) throw new Error(`Invalid PDF ${name}`);
  }
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(30000, Math.max(100, timeoutMs)))]) : AbortSignal.timeout(Math.min(30000, Math.max(100, timeoutMs)));
  const bytes = await downloadPdf(attachment, boundedSignal, fetchImpl);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nova-pdf-'));
  try {
    boundedSignal.throwIfAborted();
    const input = path.join(directory, 'attachment.pdf'); await writeFile(input, bytes, { mode: 0o600 });
    const result = await extractPdf(input, directory, { startPage, maxPages, maxCharacters, maxRenderedPages }, boundedSignal, spawnImpl, workerPath);
    boundedSignal.throwIfAborted();
    return { attachmentId: attachment.id || null, filename: path.basename(String(attachment.filename || attachment.name || 'attachment.pdf')).slice(0, 200), ...result };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function readContextPdfs(messages, signal, { onProgress, readPdf = readPdfAttachment, cache = new Map() } = {}) {
  const documents = []; const images = []; const warnings = []; const seen = new Set(); let processed = 0;
  for (const message of messages) for (const attachment of message.attachments || []) {
    if (!isPdfAttachment(attachment)) continue;
    signal?.throwIfAborted();
    const key = `${message.id}:${attachment.id || attachment.url}`;
    if (seen.has(key)) continue; seen.add(key);
    if (processed >= 2) { warnings.push({ messageId: message.id, error: 'Only two PDF attachments are processed per turn; request remaining PDFs separately.' }); continue; }
    processed += 1;
    try {
      await reportPreparation(onProgress, { stage: 'started', toolName: 'discord_read_pdf', arguments: { messageId: message.id, filename: attachment.filename } }, signal);
      const result = cache.get(key) || await readPdf(attachment, { signal, maxRenderedPages: Math.max(0, 3 - images.length) });
      signal?.throwIfAborted(); cache.set(key, result); while (cache.size > 4) cache.delete(cache.keys().next().value);
      documents.push({ ...result, messageId: message.id, pages: result.pages.map(({ image, ...page }) => page), untrustedContent: true });
      for (const page of result.pages) if (page.image && images.length < 3) images.push({ imageUrl: `data:${page.image.mimeType};base64,${page.image.data}`, sourceMessageId: message.id, attachmentId: result.attachmentId, pageNumber: page.pageNumber });
      await reportPreparation(onProgress, { stage: 'completed', toolName: 'discord_read_pdf', resultCount: result.pages.length }, signal);
    } catch (error) { signal?.throwIfAborted(); warnings.push({ messageId: message.id, error: String(error.message).slice(0, 200) }); await reportPreparation(onProgress, { stage: 'failed', toolName: 'discord_read_pdf' }, signal); }
  }
  return { documents, images, warnings };
}
