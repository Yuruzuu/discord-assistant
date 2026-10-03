import { shapeEmoji, shapeMessage, shapeSticker } from '../shapes.mjs';
import { directMessageOwnerId } from './target.mjs';

export function createConversationContext(client, { bot, guild, channel, directMessages = false, gifUrls = [] }) {
  let expressions;
  let expressionTime = 0;

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

  return async () => {
    const [history, expressions] = await Promise.all([client.listMessages(channel.id, { limit: 15 }), getExpressions()]);
    const messages = directMessages ? history.filter((message) => [directMessageOwnerId, bot.id].includes(message.author?.id)) : history;
    const gifs = new Set(gifUrls);
    for (const emoji of expressions.emojis) if (emoji.animated && emoji.imageUrl) gifs.add(emoji.imageUrl);
    for (const message of messages) {
      const candidates = [
        ...(message.attachments || []).map((attachment) => attachment.url),
        ...(message.content || '').matchAll(/https:\/\/[^\s<>]+/g),
      ];
      for (const candidate of candidates) {
        const value = typeof candidate === 'string' ? candidate : candidate[0];
        if (!value) continue;
        try {
          const url = new URL(value);
          if (url.protocol === 'https:' && ['cdn.discordapp.com', 'media.tenor.com', 'tenor.com', 'media.giphy.com', 'giphy.com'].includes(url.hostname) && (/\.gif$/i.test(url.pathname) || url.hostname === 'tenor.com' || url.hostname === 'giphy.com')) gifs.add(value);
        } catch {}
      }
    }

    return {
      botName: bot.username, serverName: guild?.name || null, channelName: channel.name || 'Direct Messages',
      ...(directMessages ? { directMessages: true, ownerUserId: directMessageOwnerId } : {}),
      expressions, allowedGifUrls: [...gifs].slice(0, 20),
      recentMessages: [...messages].reverse().map((message) => shapeMessage({ ...message, guild_id: guild?.id })),
    };
  };
}
