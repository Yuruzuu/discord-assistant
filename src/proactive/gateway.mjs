import { Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { setTimeout as wait } from 'node:timers/promises';
import { acceptsListenerMessage } from './target.mjs';
import { createGatewayStrategy } from './gateway-strategy.mjs';

export function createGateway({ token, guildId, channelId, directMessages = false, allServers = false, onMessage, onError = () => {}, onConnection = () => {}, clientFactory = (options) => new Client(options), readyTimeoutMs = 45000, maxAttempts = 3, sleep = wait }) {
  const cancellation = new AbortController();
  let closed = false;
  let client;
  let connecting;
  let rejectReady;
  let closing;
  const destroying = new WeakMap();
  const state = { connected: false, connectionAttempts: 0, reconnects: 0 };

  function reportError(error) { if (!closed) onError(error); }
  function connection(connected) {
    state.connected = connected;
    if (!closed) onConnection({ ...state });
  }

  function createClient() {
    const current = clientFactory({
      intents: directMessages ? [GatewayIntentBits.DirectMessages] : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: directMessages ? [Partials.Channel] : [],
      makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0, GuildMemberManager: 0, PresenceManager: 0 }),
      allowedMentions: { parse: [], repliedUser: false },
      ws: { buildStrategy: (manager) => createGatewayStrategy(manager, reportError) },
    });
    const connected = () => { if (!closed && current === client) connection(true); };
    current.on(Events.Error, reportError);
    current.on(Events.ShardError, reportError);
    current.on(Events.ClientReady, connected);
    current.on(Events.ShardResume, () => { if (!closed && current === client) { state.reconnects += 1; connected(); } });
    current.on(Events.ShardReady, connected);
    current.on(Events.ShardDisconnect, () => { if (!closed && current === client) connection(false); });
    current.on(Events.MessageCreate, (message) => {
      if (closed || current !== client || !acceptsListenerMessage({ guildId, channelId, directMessages, allServers }, { guild_id: message.guildId, channel_id: message.channelId, author: message.author, webhook_id: message.webhookId })) return;
      const incoming = {
        id: message.id, guild_id: message.guildId, channel_id: message.channelId,
        author: { id: message.author.id, username: message.author.username, global_name: message.author.globalName, bot: message.author.bot },
        content: message.content, timestamp: message.createdAt.toISOString(), webhook_id: message.webhookId,
        mentions: [...message.mentions.users.values()].map((user) => ({ id: user.id })),
        referenceAuthorId: message.mentions.repliedUser?.id || null,
        message_reference: message.reference ? { message_id: message.reference.messageId } : null,
        attachments: [...message.attachments.values()].map((attachment) => ({ url: attachment.url, filename: attachment.name, content_type: attachment.contentType })),
      };
      Promise.resolve().then(() => onMessage(incoming)).catch(reportError);
    });
    return current;
  }

  client = createClient();

  function destroy(current) {
    if (!destroying.has(current)) destroying.set(current, Promise.resolve().then(() => current.destroy()).catch(reportError));
    return destroying.get(current);
  }

  async function attempt(current) {
    let timer;
    let ready;
    let failed;
    const readiness = new Promise((resolve, reject) => {
      rejectReady = reject;
      ready = () => resolve({ id: current.user.id, username: current.user.username });
      failed = reject;
      timer = setTimeout(() => reject(new Error('Discord Gateway readiness timed out; retrying the connection.')), readyTimeoutMs);
      current.once(Events.ClientReady, ready);
      current.once(Events.Error, failed);
      current.once(Events.ShardError, failed);
    });
    try {
      const [, user] = await Promise.all([Promise.resolve().then(() => { cancellation.signal.throwIfAborted(); return current.login(token); }), readiness]);
      cancellation.signal.throwIfAborted();
      return user;
    } finally {
      clearTimeout(timer);
      rejectReady = null;
      current.off(Events.ClientReady, ready);
      current.off(Events.Error, failed);
      current.off(Events.ShardError, failed);
    }
  }

  async function run() {
    for (let index = 0; index < maxAttempts; index += 1) {
      cancellation.signal.throwIfAborted();
      state.connectionAttempts += 1;
      try { return await attempt(client); }
      catch (error) {
        await destroy(client);
        connection(false);
        if (closed || index + 1 === maxAttempts || /invalid token|authentication failed|disallowed intents|invalid intents|401/i.test(error.message)) throw error;
        reportError(error);
        await sleep(Math.min(1000 * 2 ** index, 10000), undefined, { signal: cancellation.signal });
        cancellation.signal.throwIfAborted();
        client = createClient();
      }
    }
  }

  function connect() {
    if (closed) return Promise.reject(new Error('Discord Gateway is stopped'));
    return connecting ||= run();
  }

  function close() {
    if (closed) return closing;
    closed = true;
    cancellation.abort();
    rejectReady?.(new DOMException('Discord Gateway stopped', 'AbortError'));
    state.connected = false;
    return closing = destroy(client);
  }

  return { connect, guildCount: () => client.guilds.cache.size, status: () => ({ ...state }), close };
}
