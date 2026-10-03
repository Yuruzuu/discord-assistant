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
  const trigger = { id: '300000000000000001' };
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
