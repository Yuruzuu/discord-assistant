import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplyStream } from '../src/proactive/reply-stream.mjs';

test('arbitrary delta boundaries preserve escaped strings and nested sticker arrays', () => {
  const messages = [{ content: 'Text with "quotes", braces { }, \\ and 🙂', gifUrl: null, stickerIds: ['400000000000000001'] }, { content: 'second', gifUrl: null, stickerIds: [] }];
  const serialized = JSON.stringify({ shouldReply: true, messages });
  const emitted = [];
  const stream = createReplyStream((message, index) => emitted.push({ message, index }));
  for (const character of serialized) stream.push(character);
  assert.deepEqual(emitted.map((value) => value.message), messages);
  assert.deepEqual(emitted.map((value) => value.index), [0, 1]);
  assert.equal(stream.text(), serialized);
});

test('false or absent reply intent does not publish a prefix', () => {
  for (const plan of [{ shouldReply: false, messages: [{ content: 'ignored' }] }, { messages: [{ content: 'buffered' }], shouldReply: true }]) {
    const emitted = [];
    createReplyStream((message) => emitted.push(message)).push(JSON.stringify(plan));
    assert.deepEqual(emitted, []);
  }
});

test('unexpected root fields and too many bubbles cannot be streamed', () => {
  assert.throws(() => createReplyStream(() => {}).push('{"extra":true,"shouldReply":true,"messages":['), /unexpected reply field/);
  assert.throws(() => createReplyStream(() => {}).push(JSON.stringify({ shouldReply: true, messages: Array.from({ length: 6 }, () => ({ content: 'x' })) })), /too many/);
});
