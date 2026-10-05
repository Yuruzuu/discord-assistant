import { shapeEmoji, shapeMessage, shapeSticker } from '../shapes.mjs';
import { directMessageOwnerId } from './target.mjs';
import { resolveTimeZone } from '../activity.mjs';
import { readContextImages, transcribeVoiceNotes, reportPreparation } from './context-media.mjs';

const gifHosts = new Set(['cdn.discordapp.com', 'media.tenor.com', 'tenor.com', 'media.giphy.com', 'giphy.com']);

export function createConversationContext(client, { bot, guild, channel, directMessages = false, gifUrls = [] }, options = {}) {
  let expressions;
  let expressionTime = 0;
  const transcriptCache = new Map();
  const ownerOrBot = (message) => [directMessageOwnerId, bot.id].includes(message.author?.id);

  async function getExpressions() {
    if (directMessages) return { emojis: [], stickers: [] };
    if (expressions && Date.now() - expressionTime < 60000) return expressions;
    const [emojis, stickers, member] = await Promise.all([
      client.listGuildEmojis(guild.id), client.listGuildStickers(guild.id), client.getGuildMember(guild.id, bot.id),
    ]);
    expressions = {
      emojis: emojis.filter((emoji) => emoji.available !== false && (!emoji.roles?.length || emoji.roles.some((id) => (member.roles || []).includes(id)))).map(shapeEmoji),
      stickers: stickers.filter((sticker) => sticker.available !== false).map(shapeSticker),
    };
    expressionTime = Date.now();
    return expressions;
  }

  return async (triggerMessages = [], signal, preparation = {}) => {
    signal?.throwIfAborted();
    const [history, expressions] = await Promise.all([client.listMessages(channel.id, { limit: 15 }), getExpressions()]);
    const messages = directMessages ? history.filter(ownerOrBot) : history;
    const replyMessages = [];
    const mediaWarnings = [];
    for (const trigger of triggerMessages.slice(-5)) {
      signal?.throwIfAborted();
      const reference = trigger.message_reference || { message_id: trigger.replyTo, channel_id: trigger.channelId };
      if (!reference.message_id || (reference.channel_id && reference.channel_id !== channel.id)) continue;
      if (replyMessages.some((message) => message.id === reference.message_id)) continue;
      try {
        await reportPreparation(preparation.onProgress, { stage: 'started', toolName: 'reply_context' }, signal);
        const parent = trigger.referenced_message || await client.getMessage(channel.id, reference.message_id);
        if (directMessages && !ownerOrBot(parent)) { await reportPreparation(preparation.onProgress, { stage: 'completed', toolName: 'reply_context', resultCount: 0 }, signal); continue; }
        replyMessages.push(parent);
        await reportPreparation(preparation.onProgress, { stage: 'completed', toolName: 'reply_context', resultCount: 1 }, signal);
      } catch (error) { signal?.throwIfAborted(); mediaWarnings.push({ messageId: reference.message_id, error: String(error.message).slice(0, 200) }); await reportPreparation(preparation.onProgress, { stage: 'failed', toolName: 'reply_context' }, signal); }
    }
    const relevant = [...triggerMessages, ...replyMessages];
    const snapshots = relevant.flatMap((message) => (message.message_snapshots || []).slice(0, 5).map(({ message: snapshot }) => ({ id: message.id, snapshot })));
    const forwardedMedia = snapshots.map(({ id, snapshot }) => ({ id, attachments: snapshot?.attachments || [], untrustedContent: true }));
    const mediaSources = [...relevant, ...forwardedMedia];
    const [media, voice] = await Promise.all([
      options.media === false ? { images: [], warnings: [] } : readContextImages(client, mediaSources, options.media, signal, preparation),
      transcribeVoiceNotes(mediaSources, options.transcribe, signal, { ...preparation, cache: transcriptCache }),
    ]);
    const forwardedMessages = snapshots.map(({ id, snapshot }) => ({ sourceMessageId: id, content: String(snapshot?.content || '').slice(0, 10000), untrustedContent: true }));
    const gifs = new Set(gifUrls);
    for (const emoji of expressions.emojis) if (emoji.animated && emoji.imageUrl) gifs.add(emoji.imageUrl);
    for (const message of messages) {
      for (const value of [...(message.attachments || []).map((attachment) => attachment.url), ...Array.from((message.content || '').matchAll(/https:\/\/[^\s<>]+/g), (match) => match[0])]) {
        if (!value) continue;
        try {
          const url = new URL(value);
          if (url.protocol === 'https:' && gifHosts.has(url.hostname) && (/\.gif$/i.test(url.pathname) || url.hostname === 'tenor.com' || url.hostname === 'giphy.com')) gifs.add(value);
        } catch {}
      }
    }

    return {
      channelId: channel.id, guildId: guild?.id || null, currentTime: new Date().toISOString(), currentUnix: Math.floor(Date.now() / 1000), ownerTimeZone: resolveTimeZone(options.timeZone),
      botName: bot.username, serverName: guild?.name || null, channelName: channel.name || 'Direct Messages',
      ...(directMessages ? { directMessages: true, ownerUserId: directMessageOwnerId } : {}),
      expressions, allowedGifUrls: [...gifs].slice(0, 20),
      replyMessages: replyMessages.map((message) => ({ ...shapeMessage({ ...message, channel_id: channel.id, guild_id: guild?.id }), untrustedContent: true })),
      forwardedMessages, images: media.images, voiceTranscripts: voice.transcripts,
      mediaWarnings: [...mediaWarnings, ...media.warnings, ...voice.warnings],
      recentMessages: [...messages].reverse().map((message) => shapeMessage({ ...message, guild_id: guild?.id })),
    };
  };
}
