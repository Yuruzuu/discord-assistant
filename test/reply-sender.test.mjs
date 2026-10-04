import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplySender } from '../src/proactive/reply-sender.mjs';

test('streamed bubbles reuse routing, preserve nonces and reference the trigger only once', async () => {
  let resolutions = 0;
  const payloads = [];
  const channelId = '200000000000000001';
  const service = { resolveChannel: async () => {
    resolutions += 1;
    return { channel: { id: channelId }, account: { id: 'reader', client: { sendMessage: async (_, payload) => { payloads.push(payload); return { id: `40000000000000000${payloads.length}`, content: payload.content }; } } } };
  } };
  const send = createReplySender(service, { channelId, listenerId: 'fixture' });
  const trigger = { id: '300000000000000001', message_reference: { message_id: '300000000000000000' } };
  const first = await send([{ content: 'First' }], trigger, undefined, { offset: 0 });
  const second = await send([{ content: 'Second' }], trigger, undefined, { offset: 1 });
  assert.equal(resolutions, 1);
  assert.equal(first.batchId, second.batchId);
  assert.equal(payloads[0].message_reference.message_id, trigger.id);
  assert.equal(payloads[1].message_reference, undefined);
  assert.equal(payloads[0].nonce, `${first.batchId}:0`);
  assert.equal(payloads[1].nonce, `${first.batchId}:1`);
  assert.deepEqual(payloads[1].allowed_mentions, { parse: [] });
  await send([{ content: 'Next reply' }], { id: '300000000000000002' });
  assert.equal(resolutions, 2);
});

test('progress uses separate identities and leaves all five final bubbles available for the native reply', async () => {
  let resolutions = 0;
  const payloads = [];
  const channelId = '200000000000000001';
  const service = { resolveChannel: async () => {
    resolutions += 1;
    return { channel: { id: channelId }, account: { id: 'reader', client: { sendMessage: async (_, payload) => {
      payloads.push(payload);
      return { id: `40000000000000000${payloads.length}`, content: payload.content };
    } } } };
  } };
  const send = createReplySender(service, { channelId, listenerId: 'fixture' });
  const trigger = { id: '300000000000000001', message_reference: { message_id: '300000000000000000' } };
  const progress = await send.progress('checking chats', trigger, undefined, { index: 0 });
  await send.progress('reading context', trigger, undefined, { index: 1 });
  const final = await send(Array.from({ length: 5 }, (_, index) => ({ content: `Final ${index}` })), trigger);
  assert.equal(resolutions, 1);
  assert.equal(progress.batchId, final.batchId);
  assert.equal(new Set(payloads.map((payload) => payload.nonce)).size, 7);
  assert.deepEqual(payloads.slice(0, 2).map((payload) => payload.nonce), [`${final.batchId}:p0`, `${final.batchId}:p1`]);
  assert.ok(payloads.slice(0, 2).every((payload) => payload.message_reference === undefined));
  assert.ok(payloads.slice(0, 2).every((payload) => payload.allowed_mentions.parse.length === 0));
  assert.equal(payloads[2].message_reference.message_id, trigger.id);
  assert.equal(payloads[2].nonce, `${final.batchId}:0`);
  assert.ok(payloads.slice(3).every((payload) => payload.message_reference === undefined));
  await assert.rejects(send.progress('too many', trigger, undefined, { index: 3 }), /Invalid progress/);
});

test('cancelled progress sends do not perform channel resolution or posting', async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  const send = createReplySender({ resolveChannel: () => { throw new Error('Should not resolve'); } }, { channelId: '200000000000000001', listenerId: 'fixture' });
  await assert.rejects(send.progress('checking chats', { id: '300000000000000001' }, cancellation.signal), { name: 'AbortError' });
});
