import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// The parser and renderer run in a bounded child process, without URLs or application credentials.
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D, pdfjsWorker: { WorkerMessageHandler } });
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const bundledAssets = new URL('./pdf-assets/', import.meta.url);
const assetRoot = await access(new URL('standard_fonts/', bundledAssets)).then(() => bundledAssets).catch(() => new URL('./', import.meta.resolve('pdfjs-dist/package.json')));

async function extract() {
  const [input, firstPage, selectedPages, characterBudget, renderBudget] = process.argv.slice(2);
  const task = getDocument({ data: new Uint8Array(await readFile(input)), verbosity: 0, isEvalSupported: false, maxImageSize: 16 * 1024 * 1024, standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', assetRoot)), cMapUrl: fileURLToPath(new URL('cmaps/', assetRoot)), cMapPacked: true, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, useWasm: false, disableAutoFetch: true, stopAtErrors: true });
  let document;
  try {
    document = await task.promise;
    if (document.numPages > 300) throw new Error('PDF exceeds the 300-page document limit');
    const startPage = Number(firstPage); const endPage = Math.min(document.numPages, startPage + Number(selectedPages) - 1);
    if (startPage > document.numPages) throw new Error('Requested PDF page does not exist');
    const pages = []; let characters = 0; let rendered = 0; let truncated = false;
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const completeText = content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();
        const available = Math.max(0, Number(characterBudget) - characters);
        const text = completeText.slice(0, Math.min(20000, available)); characters += text.length;
        const entry = { pageNumber, text, textTruncated: text.length < completeText.length };
        if (entry.textTruncated) truncated = true;
        if (text.replace(/\s/g, '').length < 40 && rendered < Number(renderBudget)) {
          const original = page.getViewport({ scale: 1 });
          if (![original.width, original.height].every((size) => Number.isFinite(size) && size > 0)) throw new Error('PDF page has invalid dimensions');
          const viewport = page.getViewport({ scale: Math.min(2, 1280 / Math.max(original.width, original.height)) });
          const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
          await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
          const image = canvas.toBuffer('image/jpeg', 70);
          if (image.length <= 2 * 1024 * 1024) { entry.image = { mimeType: 'image/jpeg', data: image.toString('base64') }; rendered += 1; }
          else entry.warning = 'Page image exceeds the rendering byte limit';
        } else if (!text) entry.warning = 'This page has no extractable text; request this page separately for image reading';
        pages.push(entry);
      } finally { page.cleanup(); }
      if (characters >= Number(characterBudget)) { truncated ||= pageNumber < endPage; break; }
    }
    const lastPage = pages.at(-1)?.pageNumber || startPage;
    return { pageCount: document.numPages, startPage, pages, truncated, nextPage: lastPage < document.numPages ? lastPage + 1 : null, untrustedContent: true };
  } finally { await (document || task).destroy(); }
}

try { process.stdout.write(JSON.stringify(await extract())); }
catch (error) { process.stderr.write(error?.name === 'PasswordException' ? 'PDF is password protected' : 'PDF could not be safely parsed or rendered'); process.exitCode = 1; }
