import { createHash } from 'node:crypto';
import { forwardResolvedMessage, markSendStatus, sendResolvedMessage } from '../messaging.mjs';
import { normalizeReactionEmoji } from '../reactions.mjs';
import { splitDiscordText, validateGeneratedFiles } from './discord-chunks.mjs';
import { shapeMessage } from '../shapes.mjs';
import { createDecorationQueue } from './progress.mjs';

export function createReplySender(service, { guildId, channelId, listenerId, directMessages = false, deliveryJournal, progressComponents, messageComponents, statusTimeoutMs = 2000, forwardSource = async () => { throw new Error('Forwarding is unavailable in this conversation'); }, sharedImage = () => null, sendTarget = async () => { throw new Error('Posting in other channels is unavailable in this conversation'); } }) {
  let currentTrigger;
  let resolution;
  const temporaryReactions = new Map();
  const naturalReactions = new Set();
  const statusQueues = new Map();
  const statusMutations = new Map();
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

  async function deliver(operationId, trigger, nonce, operation) {
    const metadata = { channelId, triggerMessageId: trigger.id, nonce };
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

  // A failed batch reports how far it got (batchId, sentMessages, failedMessageIndex) so callers keep the confirmed receipts.
  async function sendBatch(trigger, offset, run) {
    const batch = { batchId: batchIdFor(trigger), sentMessages: [], failedMessageIndex: offset };
    try { await run(batch); } catch (error) { throw Object.assign(error, batch); }
    return { batchId: batch.batchId, sentMessages: batch.sentMessages };
  }

  async function upload(trigger, signal, operation, suffix, post) {
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    const batchId = batchIdFor(trigger);
    const nonce = `${batchId}:${suffix}`;
    const receipt = await deliver(`${batchId}:${operation}`, trigger, nonce, async () => {
      let message;
      try { message = await post(target.account.client, nonce); } catch (error) { throw markSendStatus(error); }
      return { accountId: target.account.id, nonce, message: shapeMessage({ ...message, channel_id: channelId, guild_id: guildId }) };
    });
    rememberFirstReply(trigger, receipt);
    return { batchId, sentMessages: [receipt] };
  }

  const send = async (messages, trigger, signal, { offset = 0, replyToMessageId = trigger.message_reference?.message_id ? trigger.id : undefined } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + messages.length > 5) throw new Error('Invalid reply bubble offset');
    return sendBatch(trigger, offset, async (batch) => {
      signal?.throwIfAborted();
      const target = await resolve(trigger);
      for (const [index, message] of messages.entries()) {
        const position = offset + index;
        batch.failedMessageIndex = position;
        const chunks = splitDiscordText([message.content, message.gifUrl].filter(Boolean).join('\n'));
        for (const [chunkIndex, chunk] of chunks.entries()) {
          const nonce = chunkIndex === 0 ? `${batch.batchId}:${position}` : `${batch.batchId}:${position}c${chunkIndex}`;
          const sent = await deliver(`${batch.batchId}:${position}:text:${chunkIndex}`, trigger, nonce, () => sendResolvedMessage(target, {
            content: chunk, stickerIds: chunkIndex === 0 ? message.stickerIds : [], guildId, channelId,
            replyToMessageId: !directMessages && position === 0 && chunkIndex === 0 ? replyToMessageId : undefined,
            allowMentions: false, mentionRepliedUser: false, nonce,
          }, signal));
          batch.sentMessages.push(sent);
          if (position === 0 && chunkIndex === 0) rememberFirstReply(trigger, sent);
        }
      }
    });
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

  send.progress.edit = async (receipt, content, signal, { components } = {}) => {
    signal?.throwIfAborted();
    const target = await resolution;
    const messageId = receipt.sentMessages[0].message.id;
    await target.account.client.editMessage(channelId, messageId, { content, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) }, { signal });
  };
  send.progress.remove = async (receipt, signal) => {
    signal?.throwIfAborted();
    const target = await resolution;
    await target.account.client.deleteMessage(channelId, receipt.sentMessages[0].message.id, { signal });
  };

  send.files = async (files, trigger, signal, { replyToMessageId } = {}) => {
    const validated = validateGeneratedFiles(files);
    if (!validated.length) return { sentMessages: [] };
    return upload(trigger, signal, 'files', 'f', (client, nonce) => client.sendMessageFiles(channelId, {
      allowed_mentions: { parse: [], replied_user: false }, nonce, enforce_nonce: true,
      ...(!directMessages && replyToMessageId ? { message_reference: { message_id: replyToMessageId, channel_id: channelId, fail_if_not_exists: true } } : {}),
    }, validated, { signal }));
  };

  send.images = async (handles, trigger, signal) => {
    if (!handles?.length) return { sentMessages: [] };
    const images = handles.slice(0, 4).map((handle) => sharedImage(handle)).filter(Boolean);
    if (images.length !== Math.min(handles.length, 4)) throw new Error('Nova selected an image that is not available in this answer');
    return upload(trigger, signal, 'images', 'i', (client, nonce) => client.sendMessageImages(channelId, { allowed_mentions: { parse: [] }, nonce, enforce_nonce: true }, images, { signal }));
  };

  send.channelMessages = async (items, trigger, signal) => {
    if (!items?.length) return { sentMessages: [] };
    if (items.length > 3) throw new Error('Provide at most 3 channel messages');
    return sendBatch(trigger, 0, async (batch) => {
      for (const [index, item] of items.entries()) {
        batch.failedMessageIndex = index;
        signal?.throwIfAborted();
        const target = await sendTarget(item.channelId, signal);
        const nonce = `${batch.batchId}:x${index}`;
        const mentionUserIds = item.notify ? [...new Set([...item.content.matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1]))].slice(0, 5) : [];
        batch.sentMessages.push(await deliver(`${batch.batchId}:channel:${index}`, trigger, nonce, async () => ({ ...await sendResolvedMessage(target, {
          channelId: target.channel.id, guildId: target.channel.guild_id, content: item.content, mentionUserIds, nonce,
        }, signal), crossChannel: true })));
      }
    });
  };

  send.confirmation = async (content, trigger, signal) => {
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    const batchId = batchIdFor(trigger);
    const nonce = `${batchId}:k`;
    const receipt = await deliver(`${batchId}:confirmation`, trigger, nonce, () => sendResolvedMessage(target, { channelId, guildId, content: content.slice(0, 2000), nonce }, signal));
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
    return sendBatch(trigger, 0, async (batch) => {
      for (const [index, forward] of forwards.entries()) {
        batch.failedMessageIndex = index;
        signal?.throwIfAborted();
        const source = await forwardSource(forward, signal);
        const nonce = `${batch.batchId}:w${index}`;
        batch.sentMessages.push(await deliver(`${batch.batchId}:forward:${index}`, trigger, nonce, () => forwardResolvedMessage(target, { guildId, channelId, source, nonce }, signal)));
      }
    });
  };

  function statusQueueFor(messageId) {
    if (!statusQueues.has(messageId)) {
      if (statusQueues.size >= 64) {
        const oldest = statusQueues.keys().next().value;
        statusQueues.get(oldest).close(); statusQueues.delete(oldest); temporaryReactions.delete(oldest);
        for (const [key, mutation] of statusMutations) if (key.startsWith(`${oldest}:`)) { mutation.cancellation.abort(); statusMutations.delete(key); }
      }
      statusQueues.set(messageId, createDecorationQueue({ timeoutMs: statusTimeoutMs, maxPending: 1 }));
    }
    return statusQueues.get(messageId);
  }

  async function statusMutation(messageId, emoji, operation, signal) {
    const key = `${messageId}:${emoji}`;
    if (naturalReactions.has(key)) return;
    const cancellation = new AbortController();
    const deliverySignal = AbortSignal.any([cancellation.signal, signal].filter(Boolean));
    const mutation = { cancellation, promise: Promise.resolve().then(() => { deliverySignal.throwIfAborted(); if (!naturalReactions.has(key)) return operation(deliverySignal); }) };
    statusMutations.set(key, mutation);
    try { await mutation.promise; }
    finally { if (statusMutations.get(key) === mutation) statusMutations.delete(key); }
  }

  async function updateStatusReaction(stage, trigger, signal) {
    const emoji = { queued: '⏳', working: '⚙️', tool: '🔎', done: '✅', error: '⚠️', stalled: '⌛' }[stage];
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    if (!target.account.client.removeOwnReaction) return;
    const previous = temporaryReactions.get(trigger.id);
    if (previous === emoji) return;
    if (previous) await statusMutation(trigger.id, previous, (deliverySignal) => target.account.client.removeOwnReaction(channelId, trigger.id, previous, { signal: deliverySignal }), signal);
    temporaryReactions.delete(trigger.id);
    if (emoji) {
      if (naturalReactions.has(`${trigger.id}:${emoji}`) || trigger.reactions?.some((reaction) => reaction.me && reaction.emoji?.name === emoji)) return;
      await statusMutation(trigger.id, emoji, (deliverySignal) => target.account.client.addReaction(channelId, trigger.id, emoji, { signal: deliverySignal }), signal);
      if (!signal?.aborted && !naturalReactions.has(`${trigger.id}:${emoji}`)) temporaryReactions.set(trigger.id, emoji);
    }
  }
  send.statusReaction = (stage, trigger, signal) => {
    return statusQueueFor(trigger.id).enqueue('status', (queueSignal) => updateStatusReaction(stage, trigger, AbortSignal.any([queueSignal, signal].filter(Boolean))));
  };
  send.clearStatusReactions = async () => {
    await Promise.all([...statusQueues.keys()].map((messageId) => send.statusReaction(undefined, { id: messageId })));
  };

  send.react = async (reaction, trigger, signal) => {
    signal?.throwIfAborted();
    const target = await resolve(trigger);
    signal?.throwIfAborted();
    const emoji = normalizeReactionEmoji(reaction.emoji);
    const key = `${reaction.messageId}:${emoji}`;
    // Reserve ownership before waiting for an in-flight delete of this exact emoji.
    // Different status emojis/messages cannot delay an authorized natural reaction.
    naturalReactions.add(key);
    if (naturalReactions.size > 1000) naturalReactions.delete(naturalReactions.values().next().value);
    const mutation = statusMutations.get(key);
    if (mutation) {
      mutation.cancellation.abort();
      let timer;
      let onAbort;
      try {
        await Promise.race([
          mutation.promise.catch(() => {}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Temporary reaction outcome is unsettled; natural reaction was not sent')), statusTimeoutMs); }),
          new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort(); }),
        ]);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    }
    signal?.throwIfAborted();
    await target.account.client.addReaction(channelId, reaction.messageId, emoji, { signal });
    if (naturalReactions.size > 1000) naturalReactions.delete(naturalReactions.values().next().value);
    if (temporaryReactions.get(reaction.messageId) === emoji) temporaryReactions.delete(reaction.messageId);
    return { messageId: reaction.messageId, reacted: true };
  };

  return send;
}
