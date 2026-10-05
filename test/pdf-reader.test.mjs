import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, cp, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { isPdfAttachment, readPdfAttachment, readContextPdfs } from '../src/proactive/pdf-reader.mjs';

function pdfFixture() {
  const stream = (commands) => `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('BT /F1 12 Tf 10 100 Td (Nova PDF: approved requirements and page citations.) Tj ET'),
    stream('1 0 0 rg 20 20 100 100 re f'),
  ];
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const crossReference = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReference}\n%%EOF\n`;
  return Buffer.from(result);
}

const attachment = { id: '123456789012345678', filename: 'requirements.pdf', content_type: 'application/pdf', url: 'https://cdn.discordapp.com/attachments/123/456/requirements.pdf' };
const fetchFixture = async () => new Response(pdfFixture(), { headers: { 'content-type': 'application/pdf' } });

test('PDF parser extracts cited page text and renders pages without text locally', async () => {
  const result = await readPdfAttachment(attachment, { fetchImpl: fetchFixture });
  assert.equal(result.pageCount, 2); assert.equal(result.pages[0].pageNumber, 1);
  assert.match(result.pages[0].text, /approved requirements/); assert.equal(result.pages[0].image, undefined);
  assert.equal(result.pages[1].text, ''); assert.equal(result.pages[1].image.mimeType, 'image/jpeg');
  assert.deepEqual([...Buffer.from(result.pages[1].image.data, 'base64').subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.equal(result.untrustedContent, true); assert.equal(result.nextPage, null);
});

test('PDF reader supports page continuation and reports bounded text', async () => {
  const first = await readPdfAttachment(attachment, { fetchImpl: fetchFixture, maxPages: 1, maxCharacters: 10 });
  assert.equal(first.pages[0].text.length, 10); assert.equal(first.truncated, true); assert.equal(first.nextPage, 2);
  const second = await readPdfAttachment(attachment, { fetchImpl: fetchFixture, startPage: first.nextPage });
  assert.equal(second.pages[0].pageNumber, 2); assert.equal(second.nextPage, null);
  await assert.rejects(readPdfAttachment(attachment, { fetchImpl: fetchFixture, startPage: 3 }), /safely parsed/);
});

test('PDF download refuses arbitrary endpoints and hostile redirects before contacting them', async () => {
  for (const url of ['http://cdn.discordapp.com/a.pdf', 'https://user:secret@cdn.discordapp.com/a.pdf', 'https://cdn.discordapp.com:8443/a.pdf', 'https://127.0.0.1/a.pdf', 'https://cdn.discordapp.com.evil.example/a.pdf']) {
    await assert.rejects(readPdfAttachment({ ...attachment, url }, { fetchImpl: async () => { throw new Error('must not fetch'); } }), /approved Discord/);
  }
  const requests = [];
  await assert.rejects(readPdfAttachment(attachment, { fetchImpl: async (url) => { requests.push(String(url)); return new Response(null, { status: 302, headers: { location: 'https://private.example/a.pdf' } }); } }), /approved Discord/);
  assert.equal(requests.length, 1);
});

test('PDF signature, MIME, declared and streamed size limits are enforced before parsing', async () => {
  for (const response of [new Response('not pdf', { headers: { 'content-type': 'application/pdf' } }), new Response(pdfFixture(), { headers: { 'content-type': 'text/html' } }), new Response(pdfFixture(), { headers: { 'content-type': 'application/pdf', 'content-length': String(17 * 1024 * 1024) } }), new Response(Buffer.alloc(16 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/pdf' } })]) {
    await assert.rejects(readPdfAttachment(attachment, { fetchImpl: async () => response, spawnImpl: () => { throw new Error('must not spawn'); } }), /signature|not a PDF|16 MiB/);
  }
  await assert.rejects(readPdfAttachment({ ...attachment, size: 17 * 1024 * 1024 }, { fetchImpl: async () => { throw new Error('must not fetch'); } }), /16 MiB/);
  await assert.rejects(readPdfAttachment(attachment, { maxPages: 21 }), /Invalid PDF maxPages/);
});

test('PDF child cancellation kills parser, clears private input and never forwards secrets', async () => {
  const controller = new AbortController(); let argumentsValue; let optionsValue; let killed = false;
  const spawnImpl = (_command, args, options) => {
    argumentsValue = args; optionsValue = options;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', null)); };
    setImmediate(() => controller.abort(new Error('owner stopped')));
    return child;
  };
  await assert.rejects(readPdfAttachment(attachment, { fetchImpl: fetchFixture, spawnImpl, signal: controller.signal }), /owner stopped/);
  assert.equal(killed, true); assert.ok(argumentsValue.includes('--max-old-space-size=192'));
  assert.equal(optionsValue.env.DISCORD_TOKEN, undefined); assert.equal(optionsValue.env.HOME, undefined);
  await assert.rejects(access(optionsValue.cwd), { code: 'ENOENT' });
});

test('PDF preparation deduplicates attachments, preserves citations and bounds automatic reading', async () => {
  let reads = 0; const cache = new Map();
  const readPdf = async (value) => { reads += 1; return { attachmentId: value.id, filename: value.filename, pageCount: 1, pages: [{ pageNumber: 1, text: 'source', image: { mimeType: 'image/jpeg', data: '/9j/' } }], nextPage: null }; };
  const message = { id: 'message', attachments: [attachment] };
  const result = await readContextPdfs([message, message], undefined, { readPdf, cache });
  assert.equal(reads, 1); assert.equal(result.documents.length, 1); assert.equal(result.documents[0].pages[0].image, undefined);
  assert.equal(result.images[0].pageNumber, 1); assert.equal(result.images[0].sourceMessageId, 'message');
  assert.equal(result.documents[0].untrustedContent, true);
  await readContextPdfs([message], undefined, { readPdf, cache }); assert.equal(reads, 1);
  const excess = await readContextPdfs(Array.from({ length: 4 }, (_, index) => ({ ...message, id: String(index) })), undefined, { readPdf });
  assert.equal(excess.documents.length, 2); assert.equal(excess.warnings.length, 2);
  assert.equal(isPdfAttachment({ filename: 'spec.PDF' }), true);
});

test('bundled standalone PDF worker extracts text with its shipped native renderer', async () => {
  const runtimeRoot = fileURLToPath(new URL('../plugins/discord/runtime/', import.meta.url));
  try { await access(path.join(runtimeRoot, 'pdf-worker.mjs')); } catch { return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nova-pdf-package-'));
  try {
    for (const entry of ['pdf-worker.mjs', 'pdf-assets', 'node_modules']) await cp(path.join(runtimeRoot, entry), path.join(directory, entry), { recursive: true });
    const result = await readPdfAttachment(attachment, { fetchImpl: fetchFixture, workerPath: path.join(directory, 'pdf-worker.mjs') });
    assert.match(result.pages[0].text, /approved requirements/); assert.equal(result.pages[1].image.mimeType, 'image/jpeg');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
