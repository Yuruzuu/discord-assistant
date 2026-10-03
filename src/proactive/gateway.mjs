import { Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { acceptsListenerMessage } from './target.mjs';

export function createGateway({ token, guildId, channelId, directMessages = false, allServers = false, onMessage, onError, clientFactory = (options) => new Client(options) }) {
  let readyTimer;
  const client = clientFactory({
    intents: directMessages ? [GatewayIntentBits.DirectMessages] : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: directMessages ? [Partials.Channel] : [],
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0, GuildMemberManager: 0, PresenceManager: 0 }),
    allowedMentions: { parse: [], repliedUser: false },
  });
  client.on(Events.Error, onError);
  client.on(Events.MessageCreate, (message) => {
    if (!acceptsListenerMessage({ guildId, channelId, directMessages, allServers }, { guild_id: message.guildId, channel_id: message.channelId, author: message.author, webhook_id: message.webhookId })) return;
    const incoming = {
      id: message.id, guild_id: message.guildId, channel_id: message.channelId,
      author: { id: message.author.id, username: message.author.username, global_name: message.author.globalName, bot: message.author.bot },
      content: message.content, timestamp: message.createdAt.toISOString(), webhook_id: message.webhookId,
      mentions: [...message.mentions.users.values()].map((user) => ({ id: user.id })),
      referenceAuthorId: message.mentions.repliedUser?.id || null,
      message_reference: message.reference ? { message_id: message.reference.messageId } : null,
      attachments: [...message.attachments.values()].map((attachment) => ({ url: attachment.url, filename: attachment.name, content_type: attachment.contentType })),
    };
    Promise.resolve(onMessage(incoming)).catch(onError);
  });

  async function connect() {
    const ready = new Promise((resolve, reject) => {
      readyTimer = setTimeout(() => { client.destroy(); reject(new Error('Discord Gateway did not become ready within 25 seconds. Check Message Content Intent and bot credentials.')); }, 25000);
      client.once(Events.ClientReady, () => { clearTimeout(readyTimer); resolve({ id: client.user.id, username: client.user.username }); });
      client.once(Events.Error, (error) => { clearTimeout(readyTimer); reject(error); });
    });
    try {
      const [, user] = await Promise.all([client.login(token), ready]);
      return user;
    } catch (error) {
      clearTimeout(readyTimer);
      client.destroy();
      throw error;
    }
  }

  return { connect, guildCount: () => client.guilds.cache.size, close: () => { clearTimeout(readyTimer); client.destroy(); } };
}
