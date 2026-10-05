import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { assertSnowflake } from './discord-url.mjs';
import { shapeEmoji, shapeMessage, shapeSticker } from './shapes.mjs';

export async function listExpressions(service, { guildId, kind = 'all' }) {
  if (!['all', 'emojis', 'stickers'].includes(kind)) throw new Error('kind must be all, emojis, or stickers');

  const { account, guild } = await service.resolveGuild(guildId);
  const [emojis, stickers] = await Promise.all([
    kind === 'stickers' ? [] : account.client.listGuildEmojis(guildId),
    kind === 'emojis' ? [] : account.client.listGuildStickers(guildId),
  ]);

  return {
    accountId: account.id,
    guild: { id: guild.id, name: guild.name },
    emojis: emojis.map(shapeEmoji),
    stickers: stickers.map((sticker) => shapeSticker({ ...sticker, guild_id: sticker.guild_id || guildId })),
  };
}

function validateMessage({ content, stickerIds = [], gifUrl, nonce, replyToMessageId, mentionRepliedUser = false }) {
  if (content !== undefined && (typeof content !== 'string' || content.length > 2000)) {
    throw new Error('content must be a string of at most 2000 characters');
  }
  if (!Array.isArray(stickerIds) || stickerIds.length > 3) throw new Error('Provide at most 3 sticker IDs');
  for (const stickerId of stickerIds) assertSnowflake(stickerId, 'stickerId');
  if (gifUrl) {
    let url;
    try { url = new URL(gifUrl); } catch { throw new Error('gifUrl must be a valid HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || gifUrl.length > 2048) throw new Error('gifUrl must be a valid HTTPS URL');
  }
  const messageContent = gifUrl ? [content, gifUrl].filter(Boolean).join('\n') : content;
  if (messageContent && messageContent.length > 2000) throw new Error('Message content including its GIF URL must be at most 2000 characters');
  if (!messageContent?.trim() && stickerIds.length === 0) throw new Error('Provide message content or at least one sticker ID or GIF URL');
  if (replyToMessageId) assertSnowflake(replyToMessageId, 'replyToMessageId');
  if (mentionRepliedUser && !replyToMessageId) throw new Error('mentionRepliedUser requires replyToMessageId');
  if (nonce !== undefined && (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 25)) {
    throw new Error('nonce must be a string of 1 to 25 characters');
  }

  return messageContent;
}

export async function sendMessage(service, { guildId, channelId, content, stickerIds = [], gifUrl, replyToMessageId, mentionRepliedUser = false, allowMentions = false, nonce }, { signal } = {}) {
  assertSnowflake(channelId, 'channelId');
  if (guildId) assertSnowflake(guildId, 'guildId');
  validateMessage({ content, stickerIds, gifUrl, replyToMessageId, mentionRepliedUser, nonce });

  signal?.throwIfAborted();
  const resolution = await service.resolveChannel(channelId, guildId);

  return sendResolvedMessage(resolution, { guildId, channelId, content, stickerIds, gifUrl, replyToMessageId, mentionRepliedUser, allowMentions, nonce }, signal);
}

// Every send carries a nonce with enforce_nonce so Discord drops duplicates; a failure without a 4xx answer has an unknown outcome.
// A 4xx means Discord refused the send; anything else (5xx, network) leaves the outcome unknown, so it is never resent automatically.
export function markSendStatus(error) {
  error.sendStatus = error.status && error.status < 500 ? 'rejected' : 'unknown';
  return error;
}

async function postMessage({ account, channel }, { guildId, channelId, nonce }, payload, signal) {
  signal?.throwIfAborted();
  const messageNonce = nonce ?? randomBytes(12).toString('hex');
  let message;
  try {
    message = await account.client.sendMessage(channelId, { ...payload, nonce: messageNonce, enforce_nonce: true }, { signal });
  } catch (error) {
    error.nonce = messageNonce;
    if (markSendStatus(error).sendStatus === 'unknown') {
      error.message += ' The send outcome is unknown; reuse the provided nonce if retrying.';
    }

    throw error;
  }

  return {
    accountId: account.id,
    nonce: messageNonce,
    message: shapeMessage({ ...message, channel_id: message.channel_id || channelId, guild_id: message.guild_id || channel.guild_id || guildId }),
  };
}

export async function sendResolvedMessage(resolution, { guildId, channelId, content, stickerIds = [], gifUrl, replyToMessageId, mentionRepliedUser = false, allowMentions = false, mentionUserIds = [], nonce }, signal) {
  const messageContent = validateMessage({ content, stickerIds, gifUrl, replyToMessageId, mentionRepliedUser, nonce });
  return postMessage(resolution, { guildId, channelId, nonce }, {
    ...(messageContent === undefined ? {} : { content: messageContent }),
    ...(stickerIds.length ? { sticker_ids: stickerIds } : {}),
    ...(replyToMessageId ? { message_reference: { message_id: replyToMessageId, channel_id: channelId, fail_if_not_exists: true } } : {}),
    allowed_mentions: {
      parse: allowMentions ? ['users', 'roles', 'everyone'] : [],
      ...(!allowMentions && mentionUserIds.length ? { users: mentionUserIds.slice(0, 10) } : {}),
      ...(replyToMessageId ? { replied_user: mentionRepliedUser } : {}),
    },
  }, signal);
}

function validateBatch({ guildId, channelId, replyToMessageId, messages, intervalMs, batchId }, maximum, countError) {
  assertSnowflake(channelId, 'channelId');
  if (guildId) assertSnowflake(guildId, 'guildId');
  if (replyToMessageId) assertSnowflake(replyToMessageId, 'replyToMessageId');
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > maximum) throw new Error(countError);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000) throw new Error('intervalMs must be an integer from 0 to 5000');
  if (batchId !== undefined && !/^[A-Za-z0-9_-]{1,20}$/.test(batchId)) throw new Error('batchId must contain 1 to 20 letters, digits, underscores, or hyphens');
}

// Sends stop at the first failure, which carries the batch ID, the receipts already sent and the failing index so callers never resend those.
async function sendInOrder(service, { guildId, channelId, intervalMs, batchId }, items, send, { sleep, signal }) {
  const identifier = batchId || randomBytes(10).toString('hex');
  const sentMessages = [];
  let failedMessageIndex = 0;
  try {
    signal?.throwIfAborted();
    const resolution = await service.resolveChannel(channelId, guildId);
    for (const [index, item] of items.entries()) {
      failedMessageIndex = index;
      signal?.throwIfAborted();
      if (index > 0 && intervalMs > 0) await sleep(intervalMs, undefined, signal ? { signal } : undefined);
      sentMessages.push(await send(resolution, item, index, identifier));
    }
  } catch (error) {
    error.batchId = identifier;
    error.sentMessages = sentMessages;
    error.failedMessageIndex = failedMessageIndex;
    throw error;
  }

  return { batchId: identifier, sentMessages };
}

export async function sendMessageBatch(service, { guildId, channelId, messages, replyToMessageId, mentionRepliedUser = false, allowMentions = false, intervalMs = 650, batchId }, { sleep = wait, signal } = {}) {
  validateBatch({ guildId, channelId, replyToMessageId, messages, intervalMs, batchId }, 5, 'Provide 1 to 5 messages in a batch');
  for (const message of messages) validateMessage(message);

  return sendInOrder(service, { guildId, channelId, intervalMs, batchId }, messages, (resolution, message, index, identifier) => sendResolvedMessage(resolution, {
    ...message, guildId, channelId, allowMentions,
    replyToMessageId: index === 0 ? replyToMessageId : undefined,
    mentionRepliedUser: index === 0 ? mentionRepliedUser : false,
    nonce: `${identifier}:${index}`,
  }, signal), { sleep, signal });
}

function validateForwardSource(source) {
  if (!source || typeof source !== 'object') throw new Error('Each forward needs a source message');
  assertSnowflake(source.channelId, 'source channelId');
  assertSnowflake(source.messageId, 'source messageId');
  if (source.guildId) assertSnowflake(source.guildId, 'source guildId');
}

// Discord forwards are standalone messages: the snapshot carries the source content and attachments, and no extra content or reply reference is allowed.
export async function forwardResolvedMessage(resolution, { guildId, channelId, source, nonce }, signal) {
  validateForwardSource(source);
  const { accountId, nonce: messageNonce, message } = await postMessage(resolution, { guildId, channelId, nonce }, {
    message_reference: {
      type: 1, message_id: source.messageId, channel_id: source.channelId,
      ...(source.guildId ? { guild_id: source.guildId } : {}), fail_if_not_exists: true,
    },
  }, signal);

  return { accountId, nonce: messageNonce, source: { guildId: source.guildId || null, channelId: source.channelId, messageId: source.messageId }, message };
}

export async function forwardMessages(service, { guildId, channelId, messages, intervalMs = 650, batchId }, { sleep = wait, signal } = {}) {
  validateBatch({ guildId, channelId, messages, intervalMs, batchId }, 10, 'Provide 1 to 10 messages to forward');
  const sources = messages.map((message) => {
    const source = service.normalizeReadSource(message);
    if (!source.messageId) throw new Error('Each forward needs a message URL or channelId and messageId');
    return source;
  });
  if (new Set(sources.map((source) => source.messageId)).size !== sources.length) throw new Error('Each message can only be forwarded once per call');

  return sendInOrder(service, { guildId, channelId, intervalMs, batchId }, sources, (resolution, source, index, identifier) => forwardResolvedMessage(resolution, { guildId, channelId, source, nonce: `${identifier}:f${index}` }, signal), { sleep, signal });
}
