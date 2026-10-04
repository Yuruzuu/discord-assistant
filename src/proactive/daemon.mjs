import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
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
import { createNovaSettings } from './nova-settings.mjs';
import { createControlButtons, novaSlashCommand } from './controls.mjs';
import { createDaemonControls } from './daemon-controls.mjs';
import { createResearchJobs } from './research-jobs.mjs';
import { createDigestManager } from './digests.mjs';

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
  let jobs;
  let digests;
  let controls;
  const settingsStore = createNovaSettings();
  const buttons = createControlButtons();
  let shuttingDown = false;

  function updateState(patch) {
    state = { ...state, ...patch };
    if (patch.state !== undefined || patch.running !== undefined) return stateWriter.flush(state);
    stateWriter.schedule(state);
    return Promise.resolve();
  }

  function status() {
    return { ...state, ...runtime?.status(), gateway: gateway?.status(), ...(configuration.allServers ? { watchedGuildCount: gateway?.guildCount() || 0, researchJobs: jobs?.list() || [] } : {}) };
  }

  function errorMessage(error) {
    return String(error.message).replaceAll(account.token, '[redacted]').slice(0, 500);
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await gateway?.close();
    await digests?.close();
    await jobs?.close();
    if (runtime) await runtime.close();
    else if (runtimeStartup) await runtimeStartup.then((created) => created.close()).catch(() => {});
    await updateState({ running: false, state: 'stopped', stoppedAt: new Date().toISOString() });
    buttons.close();
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
    else if (request.method === 'POST' && request.url === '/control') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > 16384) request.destroy(); });
      request.on('end', () => {
        Promise.resolve().then(async () => {
          if (!controls) throw new Error('Nova is still starting');
          const result = await controls.execute(JSON.parse(body));
          response.end(JSON.stringify({ listenerId: configuration.listenerId, result }));
        }).catch((error) => response.end(JSON.stringify({ listenerId: configuration.listenerId, result: { error: errorMessage(error) } })));
      });
    }
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
    const runtimeOptions = (guildId, channelId) => ({ settingsStore,
      progressComponents: (trigger) => buttons.create({ guildId, channelId, directMessages: configuration.directMessages, triggerMessageId: trigger.id }),
      messageComponents: (trigger, message) => buttons.create({ guildId, channelId, directMessages: configuration.directMessages, triggerMessageId: trigger.id, messageId: message.id }, ['remember', 'read-more', 'retry', 'details']),
    });
    if (configuration.allServers) {
      const scheduleReply = createReplyScheduler(preferences);
      runtime = createServerMentions({
        botUserId: bot.id, onStatus,
        resolveReplyAuthor: async (channelId, messageId) => (await client.getMessage(channelId, messageId)).author?.id,
        createRuntime: (guildId, channelId, report) => createChannelRuntime(service,
          { ...preferences, allServers: false, directMessages: false, guildId, channelId, mode: 'mentions' }, bot,
          { ...runtimeOptions(guildId, channelId), warm: false, scheduleReply, onStatus: report }),
      });
    } else {
      runtimeStartup = createChannelRuntime(service, preferences, bot, { ...runtimeOptions(configuration.guildId, configuration.channelId), onStatus: () => { if (runtime) void updateState(runtime.status()); } });
      runtime = await runtimeStartup;
    }
    if (shuttingDown) { await runtime.close(); return; }
    const getRuntime = async (guildId, channelId) => {
      if (configuration.allServers) return runtime.getRuntime(guildId, channelId);
      if (channelId !== configuration.channelId || (!configuration.directMessages && guildId !== configuration.guildId) || (configuration.directMessages && guildId)) throw new Error('This control belongs to a different conversation');
      return runtime;
    };
    if (configuration.allServers) {
      jobs = createResearchJobs({ service, accountId: account.id, bot, preferences, createRuntime: async ({ guildId, channelId, onStatus }) => {
        const conversation = await runtime.bindThread(guildId, channelId, onStatus);
        return { receive: (message) => conversation.receive({ ...message, content: `Owner research task:\n${message.content}` }), status: conversation.status, close: () => runtime.removeRuntime(guildId, channelId) };
      } });
      await jobs.ready();
      for (const job of jobs.list()) if (job.threadId) await runtime.bindThread(job.guildId, job.threadId).catch(() => {});
    }
    if (configuration.directMessages) {
      digests = createDigestManager({ service, accountId: account.id, deliver: (payload, signal) => runtime.request({
        content: `Summarize the new Discord discussions for this opted-in digest: ${payload.query}. Identify useful changes, decisions and unresolved questions with source links. Do not save lasting memory from the digest.`,
        sourceData: { guildId: payload.guildId, query: payload.query, messages: payload.messages.map((message) => ({ ...message, content: message.content?.slice(0, 1000) })) },
        purpose: 'opted-in Discord digest', signal, nonce: payload.id.replaceAll('-', '').slice(0, 12) + payload.messages.at(-1).id.slice(-12),
      }) });
      await digests.ready;
    }
    controls = createDaemonControls({ service, configuration, getRuntime, getStatus: status, jobs, digests });
    gateway = createGateway({
      token: account.token, guildId: configuration.guildId, channelId: configuration.channelId,
      directMessages: configuration.directMessages, allServers: configuration.allServers,
      onMessage: runtime.receive, onError: (error) => { void updateState({ lastError: errorMessage(error) }); },
      onControl: controls.execute, controlButtons: buttons,
      onConnection: (connection) => { void updateState({ gateway: connection, ...(connection.connected ? { lastError: null } : {}) }); },
    });
    await gateway.connect();
    await client.registerCommand(bot.id, novaSlashCommand()).catch((error) => { void updateState({ commandRegistrationError: errorMessage(error) }); });
    if (!configuration.allServers) await runtime.recover();
    else {
      const deliveryRoot = join(homedir(), '.local', 'share', 'discord-mcp', 'delivery');
      for (const name of await readdir(deliveryRoot).catch(() => [])) {
        const match = new RegExp(`^${account.id}-(\\d{17,20})\\.json$`).exec(name);
        if (!match) continue;
        const record = JSON.parse(await readFile(join(deliveryRoot, name), 'utf8'));
        const pending = record.ingress?.find((entry) => entry.status !== 'completed' && entry.guildId);
        if (pending) await (await runtime.getRuntime(pending.guildId, pending.channelId)).recover();
      }
    }
    if (!shuttingDown) await updateState({ ...status(), running: true, state: 'running', botName: bot.username, lastError: null });
  } catch (error) {
    await gateway?.close();
    await digests?.close();
    await jobs?.close();
    await runtime?.close();
    if (shuttingDown) return;
    await updateState({ running: false, state: 'failed', lastError: errorMessage(error) });
    server.close(); process.exitCode = 1;
  }
}

main().catch((error) => { process.stderr.write(`[discord-proactive] ${error.message}\n`); process.exitCode = 1; });
