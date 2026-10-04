import { createHash } from 'node:crypto';
import { forwardResolvedMessage, sendResolvedMessage } from '../messaging.mjs';
import { normalizeReactionEmoji } from '../reactions.mjs';
import { splitDiscordText, validateGeneratedFiles } from './discord-chunks.mjs';
import { shapeMessage } from '../shapes.mjs';

export function createReplySender(service, { guildId, channelId, listenerId, directMessages = false, deliveryJournal, progressComponents, messageComponents, forwardSource = async () => { throw new Error('Forwarding is unavailable in this conversation'); }, sharedImage = () => null }) {
  let currentTrigger;
  let resolution;
  const temporaryReactions = new Map();
  const naturalReactions = new Set();
  let reactionQueue = Promise.resolve();
  const componentCards = new Set();
  const firstReplies = new Map();

  async function attachComponents(target, trigger, confirmed, signal, factory) {
    if (!factory || signal?.aborted) return;
    try {
      const components = await factory(trigger, confirmed.message);
      signal?.throwIfAborted();
      if (components?.length) await target.account.client.editMessage(channelId, confirmed.message.id, { components }, { signal });
    } catch { /* Controls are optional decoration on an already confirmed message. */ }
  }

  // Owner buttons are opt-in per reply: remember the first confirmed message and attach only when the final plan asks for controls.
  function rememberFirstReply(trigger, confirmed) {
    if (firstReplies.has(trigger.id)) return;
    firstReplies.set(trigger.id, confirmed);
    if (firstReplies.size > 1000) firstReplies.delete(firstReplies.keys().next().value);
  }

  async function deliver(operationId, operation, metadata) {
    const previous = await deliveryJournal?.lookup(operationId);
    if (previous?.status === 'unknown') throw new Error('A previous delivery outcome is unknown; inspect its receipt before retrying');
    if (previous?.receipt) return previous.receipt;
    let receipt;
    try {
      await deliveryJournal?.begin?.(operationId, metadata);
      receipt = await operation();
      await deliveryJournal?.record(operationId, receipt);
      return receipt;
    } catch (error) {
      if (receipt) error.sendStatus = 'unknown';
      if (error.sendStatus === 'unknown') await deliveryJournal?.unknown(operationId, { ...metadata, ...(receipt ? { receipt } : {}) });
      else if (error.sendStatus === 'rejected') await deliveryJournal?.resolve?.(operationId, { delivered: false });
      throw error;
    }
  }

  function batchIdFor(trigger) {
    return createHash('sha256').update(`${listenerId}:${trigger.id}`).digest('hex').slice(0, 20);
  }

  function resolve(trigger) {
    if (currentTrigger !== trigger.id) {
      currentTrigger = trigger.id;
      resolution = service.resolveChannel(channelId, guildId);
    }
    return resolution;
  }

  const send = async (messages, trigger, signal, { offset = 0, replyToMessageId = trigger.message_reference?.message_id ? trigger.id : undefined } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + messages.length > 5) throw new Error('Invalid reply bubble offset');
    const batchId = batchIdFor(trigger);
    const sentMessages = [];
    let failedMessageIndex = offset;
    try {
      signal?.throwIfAborted();
      const target = await resolve(trigger);
      for (const [index, message] of messages.entries()) {
        const position = offset + index;
        failedMessageIndex = position;
        const content = [message.content, message.gifUrl].filter(Boolean).join('\n');
        const chunks = splitDiscordText(content);
        for (const [chunkIndex, chunk] of chunks.entries()) {
          const nonce = chunkIndex === 0 ? `${batchId}:${position}` : `${batchId}:${position}c${chunkIndex}`;
          const sent = await deliver(`${batchId}:${position}:text:${chunkIndex}`, () => sendResolvedMessage(target, {
            content: chunk, stickerIds: chunkIndex === 0 ? message.stickerIds : [], guildId, channelId,
            replyToMessageId: !directMessages && position === 0 && chunkIndex === 0 ? replyToMessageId : undefined,
            allowMentions: false, mentionRepliedUser: false, nonce,
          }, signal), { channelId, triggerMessageId: trigger.id, nonce });
          sentMessages.push(sent);
          if (position === 0 && chunkIndex === 0) rememberFirstReply(trigger, sent);
        }
      }
    } catch (error) {
      error.batchId = batchId;
      error.sentMessages = sentMessages;
      error.failedMessageIndex = failedMessageIndex;
      throw error;
    }

    return { batchId, sentMessages };
  };

  send.progress = async (content, trigger, signal, { index = 0 } = {}) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 3) throw new Error('Invalid progress message index');
    signal?.throwIfAborted();
    const batchId = batchIdFor(trigger);
    const target = await resolve(trigger);
    const message = await sendResolvedMessage(target, {
      content, guildId, channelId, allowMentions: false, nonce: `${batchId}:p${index}`,
    }, signal);
    await attachComponents(target, trigger, message, signal, progressComponents);
    return { batchId, sentMessages: [message] };
  };

  send.progress.edit = async (receipt, content, signal) => {
    signal?.throwIfAborted();
    const target = await resolution;
    const messageId = receipt.sentMessages[0].message.id;
    await target.account.client.editMessage(channelId, messageId, { content, allowed_mentions: { parse: [] } }, { signal });
  };
  send.progress.remove = async (receipt, signal) => {
    signal?.throwIfAborted();
    const target = await resolution;
    await target.account.client.deleteMessage(channelId, receipt.sentMessages[0].message.id, { signal });
  };

  send.files = async (files, trigger, signal, { replyToMessageId } = {}) => {
    const validated = validateGeneratedFiles(files);
    if (!validated.length) return { sentMessages: [] };
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    const batchId = batchIdFor(trigger);
    const nonce = `${batchId}:f`;
    const receipt = await deliver(`${batchId}:files`, async () => {
      let message;
      try {
        message = await target.account.client.sendMessageFiles(channelId, {
          allowed_mentions: { parse: [], replied_user: false }, nonce, enforce_nonce: true,
          ...(!directMessages && replyToMessageId ? { message_reference: { message_id: replyToMessageId, channel_id: channelId, fail_if_not_exists: true } } : {}),
        }, validated, { signal });
      } catch (error) { error.sendStatus = error.status && error.status < 500 ? 'rejected' : 'unknown'; throw error; }
      return { accountId: target.account.id, nonce, message: shapeMessage({ ...message, channel_id: channelId, guild_id: guildId }) };
    }, { channelId, triggerMessageId: trigger.id, nonce });
    rememberFirstReply(trigger, receipt);
    return { batchId, sentMessages: [receipt] };
  };

  send.images = async (handles, trigger, signal) => {
    if (!handles?.length) return { sentMessages: [] };
    const images = handles.slice(0, 4).map((handle) => sharedImage(handle)).filter(Boolean);
    if (images.length !== Math.min(handles.length, 4)) throw new Error('Nova selected an image that is not available in this answer');
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    const batchId = batchIdFor(trigger);
    const nonce = `${batchId}:i`;
    const receipt = await deliver(`${batchId}:images`, async () => {
      let message;
      try {
        message = await target.account.client.sendMessageImages(channelId, { allowed_mentions: { parse: [] }, nonce, enforce_nonce: true }, images, { signal });
      } catch (error) { error.sendStatus = error.status && error.status < 500 ? 'rejected' : 'unknown'; throw error; }
      return { accountId: target.account.id, nonce, message: shapeMessage({ ...message, channel_id: channelId, guild_id: guildId }) };
    }, { channelId, triggerMessageId: trigger.id, nonce });
    rememberFirstReply(trigger, receipt);
    return { batchId, sentMessages: [receipt] };
  };

  send.controls = async (trigger, signal) => {
    const confirmed = firstReplies.get(trigger.id);
    if (!messageComponents || !confirmed || signal?.aborted || componentCards.has(trigger.id)) return false;
    componentCards.add(trigger.id);
    if (componentCards.size > 1000) componentCards.delete(componentCards.values().next().value);
    await attachComponents(await resolve(trigger), trigger, confirmed, signal, messageComponents);
    return true;
  };

  send.forwards = async (forwards, trigger, signal) => {
    if (!forwards?.length) return { sentMessages: [] };
    if (forwards.length > 5) throw new Error('Provide at most 5 forwards');
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    const batchId = batchIdFor(trigger);
    const sentMessages = [];
    let failedMessageIndex = 0;
    try {
      for (const [index, forward] of forwards.entries()) {
        failedMessageIndex = index;
        signal?.throwIfAborted();
        const source = await forwardSource(forward, signal);
        const nonce = `${batchId}:w${index}`;
        sentMessages.push(await deliver(`${batchId}:forward:${index}`, () => forwardResolvedMessage(target, { guildId, channelId, source, nonce }, signal), { channelId, triggerMessageId: trigger.id, nonce }));
      }
    } catch (error) {
      error.batchId = batchId;
      error.sentMessages = sentMessages;
      error.failedMessageIndex = failedMessageIndex;
      throw error;
    }

    return { batchId, sentMessages };
  };

  async function updateStatusReaction(stage, trigger, signal) {
    const emoji = { queued: '⏳', working: '⚙️', tool: '🔎', done: '✅', error: '⚠️', stalled: '⌛' }[stage];
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    if (!target.account.client.removeOwnReaction) return;
    const previous = temporaryReactions.get(trigger.id);
    if (previous === emoji) return;
    if (previous) await target.account.client.removeOwnReaction(channelId, trigger.id, previous, { signal });
    temporaryReactions.delete(trigger.id);
    if (emoji) {
      if (naturalReactions.has(`${trigger.id}:${emoji}`) || trigger.reactions?.some((reaction) => reaction.me && reaction.emoji?.name === emoji)) return;
      await target.account.client.addReaction(channelId, trigger.id, emoji, { signal });
      temporaryReactions.set(trigger.id, emoji);
    }
  }
  send.statusReaction = (stage, trigger, signal) => {
    const operation = reactionQueue.catch(() => {}).then(() => updateStatusReaction(stage, trigger, signal));
    reactionQueue = operation;
    return operation;
  };
  send.clearStatusReactions = async () => {
    await reactionQueue.catch(() => {});
    for (const messageId of [...temporaryReactions.keys()]) await send.statusReaction(undefined, { id: messageId });
  };

  send.react = async (reaction, trigger, signal) => {
    signal?.throwIfAborted();
    await reactionQueue.catch(() => {});
    const target = await resolve(trigger);
    signal?.throwIfAborted();
    const emoji = normalizeReactionEmoji(reaction.emoji);
    await target.account.client.addReaction(channelId, reaction.messageId, emoji, { signal });
    naturalReactions.add(`${reaction.messageId}:${emoji}`);
    if (naturalReactions.size > 1000) naturalReactions.delete(naturalReactions.values().next().value);
    if (temporaryReactions.get(reaction.messageId) === emoji) temporaryReactions.delete(reaction.messageId);
    return { messageId: reaction.messageId, reacted: true };
  };

  return send;
}
