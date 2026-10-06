import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextProjector } from '../src/proactive/context-projection.mjs';
import { projectToolResult } from '../src/proactive/tool-projection.mjs';

const approvedNote = 'approved note '.repeat(100);
const context = { channelId: 'dm', directMessages: true, expressions: { emojis: Array.from({ length: 10 }, (_, index) => ({ id: `emoji-${index}`, name: 'wave' })), stickers: [] }, allowedGifUrls: ['https://example.com/a.gif'], approvedMemory: approvedNote, triggerMessages: [{ id: '1', content: 'hello' }] };

test('context snapshots retain scope and current messages while omitting only successfully supplied stable fields', () => {
  const projector = createContextProjector();
  const first = projector.prepare(context);
  assert.equal(first.input.approvedMemory, context.approvedMemory);
  assert.deepEqual(first.input.expressions, context.expressions);
  assert.equal(first.input.contextSnapshots, undefined, 'Full first snapshots need no duplicate metadata');
  assert.equal(first.commit(), true);
  const next = projector.prepare({ ...context, triggerMessages: [{ id: '2', content: 'next' }] });
  assert.equal(Object.hasOwn(next.input, 'approvedMemory'), false);
  assert.equal(Object.hasOwn(next.input, 'expressions'), false);
  assert.equal(next.input.channelId, 'dm');
  assert.equal(next.input.directMessages, true);
  assert.equal(next.input.triggerMessages[0].id, '2');
  assert.equal(next.input.contextSnapshots.changed, undefined);
  assert.ok(next.input.contextSnapshots.revisions.approvedMemory);
});

test('failed turns do not advance snapshots and changes or deletions explicitly replace approved memory', () => {
  const projector = createContextProjector();
  projector.prepare(context);
  assert.equal(projector.prepare(context).input.approvedMemory, approvedNote);
  projector.prepare(context).commit();
  const changed = projector.prepare({ ...context, approvedMemory: 'replacement' });
  assert.equal(changed.input.approvedMemory, 'replacement');
  assert.equal(projector.prepare(context).input.approvedMemory, undefined, 'uncommitted replacement never advances snapshot');
  const cleared = projector.prepare({ ...context, approvedMemory: '' });
  assert.equal(cleared.input.approvedMemory, '');
  assert.ok(cleared.input.contextSnapshots.cleared.includes('approvedMemory'));
  cleared.commit();
  const deletedContext = { ...context }; delete deletedContext.approvedMemory;
  const deleted = projector.prepare(deletedContext);
  assert.equal(deleted.input.approvedMemory, null);
  assert.ok(deleted.input.contextSnapshots.cleared.includes('approvedMemory'));
});

test('reset and native compaction rehydrate snapshots and invalidate pending commits', () => {
  const projector = createContextProjector();
  projector.prepare(context).commit();
  const pending = projector.prepare(context);
  projector.reset();
  assert.equal(pending.commit(), false);
  assert.equal(projector.prepare(context).input.approvedMemory, context.approvedMemory);
  const first = projector.prepare(context);
  const competing = projector.prepare({ ...context, approvedMemory: 'stale' });
  assert.equal(first.commit(), true);
  assert.equal(first.commit(), false);
  assert.equal(competing.commit(), false);
});

test('context projection metrics report byte estimates and stable catalogue savings without changing host context', () => {
  const projector = createContextProjector();
  const large = { ...context, approvedMemory: 'saved note '.repeat(1000) };
  projector.prepare(large).commit();
  const next = projector.prepare(large);
  assert.ok(next.metrics.snapshotBytesSaved > 9000);
  assert.equal(next.metrics.estimatedTokens, Math.ceil(next.metrics.projectedBytes / 3));
  assert.equal(large.approvedMemory.length, 11000);
});

test('short chat snapshots never grow to pay revision overhead while deletion still clears older facts', () => {
  const projector = createContextProjector();
  const small = { channelId: 'dm', directMessages: true, expressions: { emojis: [], stickers: [] }, approvedMemory: '', allowedGifUrls: [] };
  for (let turn = 0; turn < 3; turn += 1) {
    const prepared = projector.prepare(small);
    assert.deepEqual(prepared.input, small);
    assert.ok(prepared.metrics.projectedBytes <= prepared.metrics.originalBytes);
    prepared.commit();
  }
  projector.prepare({ ...small, approvedMemory: 'old fact' }).commit();
  const deleted = projector.prepare(small);
  assert.equal(deleted.input.approvedMemory, '');
  assert.ok(deleted.input.contextSnapshots.cleared.includes('approvedMemory'));
});

test('model tool projections bound Unicode scalar text and arrays with source metadata and omission counts', () => {
  const source = { messageId: 'source', attachmentId: 'pdf', renderedPageNumbers: [4], pages: Array.from({ length: 90 }, (_, index) => ({ pageNumber: index + 1, text: '😀漢字'.repeat(1000) })), untrustedContent: true };
  const text = projectToolResult(source, { budget: 4096, handle: 'source-handle' });
  const projected = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= 4096);
  assert.equal(projected.messageId, 'source');
  assert.equal(projected.attachmentId, 'pdf');
  assert.equal(projected.pages[0].pageNumber, 1);
  assert.ok(projected.partial.omissions.some((entry) => entry.path === 'pages' && entry.available === 90));
  assert.ok(projected.partial.omissions.some((entry) => entry.kind === 'text'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(projected.pages[0].text));
  assert.equal(source.pages.length, 90);
});

test('duplicate connector text is omitted from the preview only when it exactly represents structuredContent', () => {
  const structuredContent = { description: 'source '.repeat(2000) };
  const projected = JSON.parse(projectToolResult({ text: JSON.stringify(structuredContent), structuredContent, privateOwnerData: true }, { budget: 4096, handle: 'source-handle' }));
  assert.equal(projected.text, undefined);
  assert.equal(projected.privateOwnerData, true);
  assert.ok(projected.partial.omissions.some((entry) => entry.kind === 'duplicate'));
  const distinct = JSON.parse(projectToolResult({ text: 'unique source '.repeat(1000), structuredContent }, { budget: 4096, handle: 'source-handle' }));
  assert.ok(distinct.text.startsWith('unique source'));
});
