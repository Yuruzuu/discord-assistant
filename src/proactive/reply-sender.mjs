import { createHash } from 'node:crypto';
import { sendResolvedMessage } from '../messaging.mjs';

export function createReplySender(service, { guildId, channelId, listenerId }) {
  let currentTrigger;
  let resolution;

  return async (messages, trigger, signal, { offset = 0 } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + messages.length > 5) throw new Error('Invalid reply bubble offset');
    const batchId = createHash('sha256').update(`${listenerId}:${trigger.id}`).digest('hex').slice(0, 20);
    const sentMessages = [];
    try {
      signal?.throwIfAborted();
      if (currentTrigger !== trigger.id) {
        currentTrigger = trigger.id;
        resolution = service.resolveChannel(channelId, guildId);
      }
      const target = await resolution;
      for (const [index, message] of messages.entries()) {
        const position = offset + index;
        const sent = await sendResolvedMessage(target, {
          ...message, guildId, channelId, replyToMessageId: position === 0 ? trigger.id : undefined,
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
}
