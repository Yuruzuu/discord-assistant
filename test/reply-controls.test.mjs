import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { validateReplyPlan } from '../src/proactive/reply-validation.mjs';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const botUserId = '500000000000000001';

test('Nova plans opt into owner buttons and the engine attaches them only when requested', async () => {
  assert.deepEqual(validateReplyPlan({ shouldReply: true, messages: [{ content: 'deep dive', gifUrl: null, stickerIds: [] }], controls: true }, {}), { shouldReply: true, messages: [{ content: 'deep dive', gifUrl: undefined, stickerIds: [] }], controls: true });
  assert.equal(validateReplyPlan({ shouldReply: true, messages: [{ content: 'hi', gifUrl: null, stickerIds: [] }], controls: false }, {}).controls, undefined);
  assert.equal(validateReplyPlan({ shouldReply: false, messages: [], controls: true }, {}).controls, undefined);

  for (const controls of [false, true]) {
    const attached = [];
    const sendReplies = async (messages) => ({ sentMessages: messages });
    sendReplies.controls = async (trigger) => { attached.push(trigger.id); return true; };
    const engine = createProactiveEngine({
      botUserId, guildId, channelId, batchWindowMs: 5, cooldownMs: 0,
      resolveReplyAuthor: async () => botUserId, getContext: async () => ({ recentMessages: [] }),
      generateReply: async () => ({ shouldReply: true, messages: [{ content: 'answer' }], ...(controls ? { controls } : {}) }), sendReplies,
    });
    try {
      const id = controls ? '400000000000000011' : '400000000000000010';
      await engine.receive({ id, guild_id: guildId, channel_id: channelId, author: { id: directMessageOwnerId, bot: false }, content: `<@${botUserId}> question`, mentions: [] });
      for (let attempt = 0; attempt < 200 && engine.status().replyBatches < 1; attempt += 1) await setTimeout(5);
      assert.deepEqual(attached, controls ? [id] : []);
    } finally { engine.stop(); }
  }
});
