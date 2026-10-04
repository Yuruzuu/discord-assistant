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

async function postMessage(account, channelId, payload, signal) {
  try {
    return await account.client.sendMessage(channelId, payload, { signal });
  } catch (error) {
    error.nonce = payload.nonce;
    error.sendStatus = error.status && error.status < 500 ? 'rejected' : 'unknown';
    if (error.sendStatus === 'unknown') {
      error.message += ' The send outcome is unknown; reuse the provided nonce if retrying.';
    }

    throw error;
  }
}

export async function sendResolvedMessage({ account, channel }, { guildId, channelId, content, stickerIds = [], gifUrl, replyToMessageId, mentionRepliedUser = false, allowMentions = false, nonce }, signal) {
  const messageContent = validateMessage({ content, stickerIds, gifUrl, replyToMessageId, mentionRepliedUser, nonce });
  signal?.throwIfAborted();
  const messageNonce = nonce ?? randomBytes(12).toString('hex');
  const message = await postMessage(account, channelId, {
    ...(messageContent === undefined ? {} : { content: messageContent }),
    ...(stickerIds.length ? { sticker_ids: stickerIds } : {}),
    ...(replyToMessageId ? { message_reference: { message_id: replyToMessageId, channel_id: channelId, fail_if_not_exists: true } } : {}),
    allowed_mentions: {
      parse: allowMentions ? ['users', 'roles', 'everyone'] : [],
      ...(replyToMessageId ? { replied_user: mentionRepliedUser } : {}),
    },
    nonce: messageNonce,
    enforce_nonce: true,
  }, signal);

  return {
    accountId: account.id,
    nonce: messageNonce,
    message: shapeMessage({ ...message, channel_id: message.channel_id || channelId, guild_id: message.guild_id || channel.guild_id || guildId }),
  };
}

export async function sendMessageBatch(service, { guildId, channelId, messages, replyToMessageId, mentionRepliedUser = false, allowMentions = false, intervalMs = 650, batchId }, { sleep = wait, signal } = {}) {
  assertSnowflake(channelId, 'channelId');
  if (guildId) assertSnowflake(guildId, 'guildId');
  if (replyToMessageId) assertSnowflake(replyToMessageId, 'replyToMessageId');
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 5) throw new Error('Provide 1 to 5 messages in a batch');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000) throw new Error('intervalMs must be an integer from 0 to 5000');
  if (batchId !== undefined && !/^[A-Za-z0-9_-]{1,20}$/.test(batchId)) throw new Error('batchId must contain 1 to 20 letters, digits, underscores, or hyphens');
  for (const message of messages) validateMessage(message);

  const identifier = batchId || randomBytes(10).toString('hex');
  const sentMessages = [];
  let failedMessageIndex = 0;
  try {
    signal?.throwIfAborted();
    const resolution = await service.resolveChannel(channelId, guildId);
    for (const [index, message] of messages.entries()) {
      failedMessageIndex = index;
      signal?.throwIfAborted();
      if (index > 0 && intervalMs > 0) await sleep(intervalMs, undefined, signal ? { signal } : undefined);
      const sent = await sendResolvedMessage(resolution, {
        ...message, guildId, channelId, allowMentions,
        replyToMessageId: index === 0 ? replyToMessageId : undefined,
        mentionRepliedUser: index === 0 ? mentionRepliedUser : false,
        nonce: `${identifier}:${index}`,
      }, signal);
      sentMessages.push(sent);
    }
  } catch (error) {
    error.batchId = identifier;
    error.sentMessages = sentMessages;
    error.failedMessageIndex = failedMessageIndex;
    throw error;
  }

  return { batchId: identifier, sentMessages };
}

function validateForwardSource(source) {
  if (!source || typeof source !== 'object') throw new Error('Each forward needs a source message');
  assertSnowflake(source.channelId, 'source channelId');
  assertSnowflake(source.messageId, 'source messageId');
  if (source.guildId) assertSnowflake(source.guildId, 'source guildId');
}

// Discord forwards are standalone messages: the snapshot carries the source content and attachments, and no extra content or reply reference is allowed.
export async function forwardResolvedMessage({ account, channel }, { guildId, channelId, source, nonce }, signal) {
  validateForwardSource(source);
  signal?.throwIfAborted();
  const messageNonce = nonce ?? randomBytes(12).toString('hex');
  const message = await postMessage(account, channelId, {
    message_reference: {
      type: 1, message_id: source.messageId, channel_id: source.channelId,
      ...(source.guildId ? { guild_id: source.guildId } : {}), fail_if_not_exists: true,
    },
    nonce: messageNonce,
    enforce_nonce: true,
  }, signal);

  return {
    accountId: account.id,
    nonce: messageNonce,
    source: { guildId: source.guildId || null, channelId: source.channelId, messageId: source.messageId },
    message: shapeMessage({ ...message, channel_id: message.channel_id || channelId, guild_id: message.guild_id || channel.guild_id || guildId }),
  };
}

export async function forwardMessages(service, { guildId, channelId, messages, intervalMs = 650, batchId }, { sleep = wait, signal } = {}) {
  assertSnowflake(channelId, 'channelId');
  if (guildId) assertSnowflake(guildId, 'guildId');
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 10) throw new Error('Provide 1 to 10 messages to forward');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000) throw new Error('intervalMs must be an integer from 0 to 5000');
  if (batchId !== undefined && !/^[A-Za-z0-9_-]{1,20}$/.test(batchId)) throw new Error('batchId must contain 1 to 20 letters, digits, underscores, or hyphens');
  const sources = messages.map((message) => {
    const source = service.normalizeReadSource(message);
    if (!source.messageId) throw new Error('Each forward needs a message URL or channelId and messageId');
    return source;
  });
  if (new Set(sources.map((source) => source.messageId)).size !== sources.length) throw new Error('Each message can only be forwarded once per call');

  const identifier = batchId || randomBytes(10).toString('hex');
  const sentMessages = [];
  let failedMessageIndex = 0;
  try {
    signal?.throwIfAborted();
    const resolution = await service.resolveChannel(channelId, guildId);
    for (const [index, source] of sources.entries()) {
      failedMessageIndex = index;
      signal?.throwIfAborted();
      if (index > 0 && intervalMs > 0) await sleep(intervalMs, undefined, signal ? { signal } : undefined);
      sentMessages.push(await forwardResolvedMessage(resolution, { guildId, channelId, source, nonce: `${identifier}:f${index}` }, signal));
    }
  } catch (error) {
    error.batchId = identifier;
    error.sentMessages = sentMessages;
    error.failedMessageIndex = failedMessageIndex;
    throw error;
  }

  return { batchId: identifier, sentMessages };
}
