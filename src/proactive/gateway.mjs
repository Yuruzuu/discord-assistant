import { Client, Events, GatewayIntentBits, Options } from 'discord.js';

export function createGateway({ token, guildId, channelId, onMessage, onError }) {
  let readyTimer;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0, GuildMemberManager: 0, PresenceManager: 0 }),
    allowedMentions: { parse: [], repliedUser: false },
  });
  client.on(Events.Error, onError);
  client.on(Events.MessageCreate, (message) => {
    if (message.guildId !== guildId || message.channelId !== channelId) return;
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

  return { connect, close: () => { clearTimeout(readyTimer); client.destroy(); } };
}
