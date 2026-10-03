import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../config.mjs';
import { DiscordService } from '../service.mjs';
import { sendMessageBatch } from '../messaging.mjs';
import { shapeEmoji, shapeMessage, shapeSticker } from '../shapes.mjs';
import { createCodexResponder } from './codex-responder.mjs';
import { createProactiveEngine } from './engine.mjs';
import { createGateway } from './gateway.mjs';
import { listenerPaths, writeState } from './state.mjs';
import { createStateWriter } from './state-writer.mjs';

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error('A proactive listener configuration file is required');
  const configuration = JSON.parse(await readFile(filename, 'utf8'));
  const settings = loadConfig();
  const account = settings.accounts.find((account) => account.id === configuration.accountId);
  if (!account) throw new Error('The selected Discord bot account is not configured');
  const service = new DiscordService({ ...settings, accounts: [account] });
  const client = service.accounts[0].client;
  const paths = listenerPaths(account.id, configuration.channelId, dirname(filename));
  let state = {
    listenerId: configuration.listenerId, running: false, state: 'starting',
    accountId: account.id, guildId: configuration.guildId, channelId: configuration.channelId,
    mode: configuration.mode, model: configuration.model || null, startedAt: new Date().toISOString(),
    lastError: null, statistics: {},
  };
  const stateWriter = createStateWriter((snapshot) => writeState(paths.status, snapshot), { onError: (error) => process.stderr.write(`[discord-proactive] status write failed: ${error.message}\n`) });
  let engine;
  let gateway;
  let shuttingDown = false;

  function updateState(patch) {
    state = { ...state, ...patch };
    if (patch.state !== undefined || patch.running !== undefined) return stateWriter.flush(state);
    stateWriter.schedule(state);
    return Promise.resolve();
  }

  function errorMessage(error) {
    return String(error.message).replaceAll(account.token, '[redacted]').slice(0, 500);
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    engine?.stop();
    gateway?.close();
    await updateState({ running: false, state: 'stopped', stoppedAt: new Date().toISOString() });
    server.close();
    setTimeout(() => process.exit(0), 1000);
  }

  const server = createServer((request, response) => {
    const authorization = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${configuration.controlToken}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/status') {
      response.end(JSON.stringify(state));
    } else if (request.method === 'POST' && request.url === '/stop') {
      response.end(JSON.stringify({ ...state, running: false, state: 'stopping' }));
      void shutdown();
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  configuration.controlUrl = `http://127.0.0.1:${server.address().port}`;
  configuration.pid = process.pid;
  await writeState(filename, configuration);
  await updateState({});
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    const [bot, guild, channel] = await Promise.all([
      client.getCurrentUser(), client.getGuild(configuration.guildId), client.getChannel(configuration.channelId),
    ]);
    const generateReply = createCodexResponder({ command: configuration.codexCommand, model: configuration.model, reasoningEffort: configuration.reasoningEffort });
    let expressions;
    let expressionTime = 0;
    async function getExpressions() {
      if (expressions && Date.now() - expressionTime < 60000) return expressions;
      const [emojis, stickers, member] = await Promise.all([
        client.listGuildEmojis(configuration.guildId), client.listGuildStickers(configuration.guildId),
        client.getGuildMember(configuration.guildId, bot.id),
      ]);
      expressions = {
        emojis: emojis.filter((emoji) => emoji.available !== false && (!emoji.roles?.length || emoji.roles.some((id) => (member.roles || []).includes(id)))).map(shapeEmoji),
        stickers: stickers.filter((sticker) => sticker.available !== false).map(shapeSticker),
      };
      expressionTime = Date.now();
      return expressions;
    }
    engine = createProactiveEngine({
      ...configuration, botUserId: bot.id,
      resolveReplyAuthor: async (messageId) => (await client.getMessage(configuration.channelId, messageId)).author?.id,
      getContext: async () => {
      const [messages, expressions] = await Promise.all([client.listMessages(configuration.channelId, { limit: 15 }), getExpressions()]);
      const gifs = new Set(configuration.gifUrls);
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
        botName: bot.username, serverName: guild.name, channelName: channel.name,
        expressions, allowedGifUrls: [...gifs].slice(0, 20),
        recentMessages: [...messages].reverse().map((message) => shapeMessage({ ...message, guild_id: guild.id })),
        };
      },
      generateReply,
      sendReplies: (messages, trigger, signal) => sendMessageBatch(service, {
        guildId: configuration.guildId, channelId: configuration.channelId, messages,
        replyToMessageId: trigger.id, intervalMs: 650,
        batchId: createHash('sha256').update(`${configuration.listenerId}:${trigger.id}`).digest('hex').slice(0, 20),
      }, { signal }),
      onStatus: (statistics) => { void updateState({ statistics }); },
    });
    gateway = createGateway({
      token: account.token, guildId: configuration.guildId, channelId: configuration.channelId,
      onMessage: (message) => engine.receive(message),
      onError: (error) => { void updateState({ lastError: errorMessage(error) }); },
    });
    await gateway.connect();
    if (!shuttingDown) await updateState({ running: true, state: 'running', botName: bot.username, channelName: channel.name, serverName: guild.name });
  } catch (error) {
    engine?.stop();
    gateway?.close();
    if (shuttingDown) return;
    await updateState({ running: false, state: 'failed', lastError: errorMessage(error) });
    server.close();
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[discord-proactive] ${error.message}\n`);
  process.exitCode = 1;
});
