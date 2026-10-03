import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../config.mjs';
import { DiscordService } from '../service.mjs';
import { createCodexResponder } from './codex-responder.mjs';
import { createConversationContext } from './context.mjs';
import { createProactiveEngine } from './engine.mjs';
import { createGateway } from './gateway.mjs';
import { listenerPaths, directMessagePaths, writeState } from './state.mjs';
import { createStateWriter } from './state-writer.mjs';
import { assertOwnerDirectMessageChannel, directMessageOwnerId } from './target.mjs';
import { startTypingIndicator } from './typing.mjs';
import { replyDefaults } from './reply-defaults.mjs';
import { createReplySender } from './reply-sender.mjs';
import { createMemoryStore, memoryPath, parseMemoryCommand } from './memory.mjs';
import { createMemoryCommandHandler } from './memory-commands.mjs';

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error('A proactive listener configuration file is required');
  const configuration = JSON.parse(await readFile(filename, 'utf8'));
  const settings = loadConfig();
  const account = settings.accounts.find((account) => account.id === configuration.accountId);
  if (!account) throw new Error('The selected Discord bot account is not configured');
  const service = new DiscordService({ ...settings, accounts: [account] });
  const client = service.accounts[0].client;
  const paths = configuration.directMessages ? directMessagePaths(account.id, dirname(filename)) : listenerPaths(account.id, configuration.channelId, dirname(filename));
  let state = {
    listenerId: configuration.listenerId, running: false, state: 'starting',
    accountId: account.id, guildId: configuration.guildId, channelId: configuration.channelId,
    mode: configuration.mode, model: configuration.model || replyDefaults.model,
    reasoningEffort: configuration.reasoningEffort || replyDefaults.reasoningEffort,
    serviceTier: configuration.serviceTier || replyDefaults.serviceTier, startedAt: new Date().toISOString(),
    ...(configuration.directMessages ? { directMessages: true, ownerUserId: directMessageOwnerId } : {}),
    lastError: null, statistics: {},
  };
  const stateWriter = createStateWriter((snapshot) => writeState(paths.status, snapshot), { onError: (error) => process.stderr.write(`[discord-proactive] status write failed: ${error.message}\n`) });
  let engine;
  let gateway;
  let generateReply;
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
    await generateReply?.close();
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
      response.end(JSON.stringify({ ...state, ...(generateReply ? { conversation: generateReply.status() } : {}) }));
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
      client.getCurrentUser(), configuration.directMessages ? null : client.getGuild(configuration.guildId), client.getChannel(configuration.channelId),
    ]);
    if (configuration.directMessages) assertOwnerDirectMessageChannel(channel);
    const scope = { channelId: configuration.channelId, guildId: guild?.id || null, directMessages: Boolean(configuration.directMessages) };
    const memory = createMemoryStore(memoryPath({ ...configuration, accountId: account.id }));
    await memory.load();
    state.memoryFile = memory.filename;
    generateReply = createCodexResponder({ command: configuration.codexCommand, model: state.model, reasoningEffort: state.reasoningEffort, serviceTier: state.serviceTier, scope });
    await generateReply.warmup();
    const conversationContext = createConversationContext(client, { bot, guild, channel, directMessages: configuration.directMessages, gifUrls: configuration.gifUrls });
    engine = createProactiveEngine({
      ...configuration, botUserId: bot.id,
      resolveReplyAuthor: async (messageId) => (await client.getMessage(configuration.channelId, messageId)).author?.id,
      getContext: async () => {
        const [context, saved] = await Promise.all([conversationContext(), memory.load()]);
        return { ...context, approvedMemory: saved.text };
      },
      parseCommand: (message) => parseMemoryCommand(message, bot.id),
      handleCommands: createMemoryCommandHandler(memory, bot.id, (messageId) => client.getMessage(configuration.channelId, messageId)),
      startTyping: (signal) => startTypingIndicator((typingSignal) => client.triggerTyping(configuration.channelId, { signal: typingSignal }), { signal }),
      generateReply,
      sendReplies: createReplySender(service, configuration),
      onStatus: (statistics) => { void updateState({ statistics, conversation: generateReply.status() }); },
    });
    gateway = createGateway({
      token: account.token, guildId: configuration.guildId, channelId: configuration.channelId,
      directMessages: configuration.directMessages,
      onMessage: (message) => engine.receive(message),
      onError: (error) => { void updateState({ lastError: errorMessage(error) }); },
    });
    await gateway.connect();
    if (!shuttingDown) await updateState({ running: true, state: 'running', botName: bot.username, channelName: channel.name || 'Direct Messages', serverName: guild?.name || null });
  } catch (error) {
    engine?.stop();
    gateway?.close();
    await generateReply?.close();
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
