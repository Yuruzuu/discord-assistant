import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../config.mjs';
import { DiscordService } from '../service.mjs';
import { createChannelRuntime } from './channel-runtime.mjs';
import { createServerMentions } from './server-mentions.mjs';
import { createReplyScheduler } from './reply-scheduler.mjs';
import { createGateway } from './gateway.mjs';
import { listenerTargetPaths, writeState } from './state.mjs';
import { createStateWriter } from './state-writer.mjs';
import { directMessageOwnerId } from './target.mjs';
import { replyDefaults } from './reply-defaults.mjs';

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error('A proactive listener configuration file is required');
  const configuration = JSON.parse(await readFile(filename, 'utf8'));
  const settings = loadConfig();
  const account = settings.accounts.find((account) => account.id === configuration.accountId);
  if (!account) throw new Error('The selected Discord bot account is not configured');
  const service = new DiscordService({ ...settings, accounts: [account] });
  const client = service.accounts[0].client;
  const paths = listenerTargetPaths({ ...configuration, accountId: account.id }, dirname(filename));
  const preferences = {
    ...configuration, model: configuration.model || replyDefaults.model,
    reasoningEffort: configuration.reasoningEffort || replyDefaults.reasoningEffort,
    serviceTier: configuration.serviceTier || replyDefaults.serviceTier,
  };
  let state = {
    listenerId: configuration.listenerId, running: false, state: 'starting',
    accountId: account.id, guildId: configuration.guildId, channelId: configuration.channelId,
    ownerUserId: directMessageOwnerId, mode: configuration.mode,
    model: preferences.model, reasoningEffort: preferences.reasoningEffort, serviceTier: preferences.serviceTier,
    startedAt: new Date().toISOString(), lastError: null, statistics: {},
    ...(configuration.directMessages ? { directMessages: true } : {}),
    ...(configuration.allServers ? { allServers: true } : {}),
  };
  const stateWriter = createStateWriter((snapshot) => writeState(paths.status, snapshot), { onError: (error) => process.stderr.write(`[discord-proactive] status write failed: ${error.message}\n`) });
  let runtime;
  let runtimeStartup;
  let gateway;
  let shuttingDown = false;

  function updateState(patch) {
    state = { ...state, ...patch };
    if (patch.state !== undefined || patch.running !== undefined) return stateWriter.flush(state);
    stateWriter.schedule(state);
    return Promise.resolve();
  }

  function status() {
    return { ...state, ...runtime?.status(), ...(configuration.allServers ? { watchedGuildCount: gateway?.guildCount() || 0 } : {}) };
  }

  function errorMessage(error) {
    return String(error.message).replaceAll(account.token, '[redacted]').slice(0, 500);
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    gateway?.close();
    if (runtime) await runtime.close();
    else if (runtimeStartup) await runtimeStartup.then((created) => created.close()).catch(() => {});
    await updateState({ running: false, state: 'stopped', stoppedAt: new Date().toISOString() });
    server.close();
    setTimeout(() => process.exit(0), 1000);
  }

  const server = createServer((request, response) => {
    const authorization = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${configuration.controlToken}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      response.writeHead(401).end(); return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/status') response.end(JSON.stringify(status()));
    else if (request.method === 'POST' && request.url === '/stop') {
      response.end(JSON.stringify({ ...status(), running: false, state: 'stopping' }));
      void shutdown();
    } else response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  configuration.controlUrl = `http://127.0.0.1:${server.address().port}`;
  configuration.pid = process.pid;
  await writeState(filename, configuration);
  await updateState({});
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    const bot = await client.getCurrentUser();
    const onStatus = (snapshot) => { void updateState(snapshot); };
    if (configuration.allServers) {
      const scheduleReply = createReplyScheduler(preferences);
      runtime = createServerMentions({
        botUserId: bot.id, onStatus,
        resolveReplyAuthor: async (channelId, messageId) => (await client.getMessage(channelId, messageId)).author?.id,
        createRuntime: (guildId, channelId, report) => createChannelRuntime(service,
          { ...preferences, allServers: false, directMessages: false, guildId, channelId, mode: 'mentions' }, bot,
          { warm: false, scheduleReply, onStatus: report }),
      });
    } else {
      runtimeStartup = createChannelRuntime(service, preferences, bot, { onStatus: () => { if (runtime) void updateState(runtime.status()); } });
      runtime = await runtimeStartup;
    }
    if (shuttingDown) { await runtime.close(); return; }
    gateway = createGateway({
      token: account.token, guildId: configuration.guildId, channelId: configuration.channelId,
      directMessages: configuration.directMessages, allServers: configuration.allServers,
      onMessage: runtime.receive, onError: (error) => { void updateState({ lastError: errorMessage(error) }); },
    });
    await gateway.connect();
    if (!shuttingDown) await updateState({ ...status(), running: true, state: 'running', botName: bot.username });
  } catch (error) {
    gateway?.close();
    await runtime?.close();
    if (shuttingDown) return;
    await updateState({ running: false, state: 'failed', lastError: errorMessage(error) });
    server.close(); process.exitCode = 1;
  }
}

main().catch((error) => { process.stderr.write(`[discord-proactive] ${error.message}\n`); process.exitCode = 1; });
