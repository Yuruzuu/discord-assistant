import { createHash } from 'node:crypto';
import { sendResolvedMessage } from '../messaging.mjs';
import { normalizeReactionEmoji } from '../reactions.mjs';

export function createReplySender(service, { guildId, channelId, listenerId, directMessages = false }) {
  let currentTrigger;
  let resolution;

  function resolve(trigger) {
    if (currentTrigger !== trigger.id) {
      currentTrigger = trigger.id;
      resolution = service.resolveChannel(channelId, guildId);
    }
    return resolution;
  }

  const send = async (messages, trigger, signal, { offset = 0, replyToMessageId = trigger.message_reference?.message_id ? trigger.id : undefined } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + messages.length > 5) throw new Error('Invalid reply bubble offset');
    const batchId = createHash('sha256').update(`${listenerId}:${trigger.id}`).digest('hex').slice(0, 20);
    const sentMessages = [];
    try {
      signal?.throwIfAborted();
      const target = await resolve(trigger);
      for (const [index, message] of messages.entries()) {
        const position = offset + index;
        const sent = await sendResolvedMessage(target, {
          ...message, guildId, channelId, replyToMessageId: !directMessages && position === 0 ? replyToMessageId : undefined,
          allowMentions: false, mentionRepliedUser: false, nonce: `${batchId}:${position}`,
        }, signal);
        sentMessages.push(sent);
      }
    } catch (error) {
      error.batchId = batchId;
      error.sentMessages = sentMessages;
      error.failedMessageIndex = offset + sentMessages.length;
      throw error;
    }

    return { batchId, sentMessages };
  };

  send.progress = async (content, trigger, signal, { index = 0 } = {}) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 3) throw new Error('Invalid progress message index');
    signal?.throwIfAborted();
    const batchId = createHash('sha256').update(`${listenerId}:${trigger.id}`).digest('hex').slice(0, 20);
    const target = await resolve(trigger);
    const message = await sendResolvedMessage(target, {
      content, guildId, channelId, allowMentions: false, nonce: `${batchId}:p${index}`,
    }, signal);
    return { batchId, sentMessages: [message] };
  };

  send.react = async (reaction, trigger, signal) => {
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    signal?.throwIfAborted();
    await target.account.client.addReaction(channelId, reaction.messageId, normalizeReactionEmoji(reaction.emoji), { signal });
    return { messageId: reaction.messageId, reacted: true };
  };

  return send;
}
