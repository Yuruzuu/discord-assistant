import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync, existsSync } from 'node:fs';
import { open, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { assertSnowflake } from '../discord-url.mjs';
import { ensureStateRoot, listenerTargetPaths, readState, writeState, proactiveRoot } from './state.mjs';
import { assertOwnerDirectMessageChannel, directMessageOwnerId } from './target.mjs';
import { replyDefaults } from './reply-defaults.mjs';

async function controlRequest(configuration, method = 'GET', route = '/status', body, timeoutMs = body ? 20000 : 3000) {
  const url = new URL(configuration.controlUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid listener control address');
  const response = await fetch(new URL(route, url), {
    method, headers: { Authorization: `Bearer ${configuration.controlToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Listener control request failed (${response.status})`);
  const status = await response.json();
  if (status.listenerId !== configuration.listenerId) throw new Error('Listener identity does not match');

  return status;
}

export function createProactiveController(service, { entrypoint = process.env.DISCORD_PROACTIVE_ENTRYPOINT || service.proactiveEntrypoint, root = proactiveRoot(), spawnImpl = spawn, commandCheck = spawnSync, shutdownTimeoutMs = 10000, shutdownPollMs = 50, processExistsImpl } = {}) {
  for (const value of [shutdownTimeoutMs, shutdownPollMs]) if (!Number.isInteger(value) || value < 1 || value > 60000) throw new Error('Shutdown deadlines must be bounded positive milliseconds');
  const stops = new Map();
  function accountForId(accountId) { return accountId ? service.accountById(accountId) : service.accounts[0]; }
  function targetPaths(accountId, channelId, directMessages, allServers) {
    return listenerTargetPaths({ accountId, channelId, directMessages, allServers }, root);
  }
  function processExists(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    if (processExistsImpl) return Boolean(processExistsImpl(pid));
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  }

  async function status({ channelId, accountId, directMessages = false, allServers = false } = {}) {
    if (!directMessages && !allServers) assertSnowflake(channelId, 'channelId');
    const account = accountForId(accountId);
    const paths = targetPaths(account.id, channelId, directMessages, allServers);
    const configuration = await readState(paths.configuration);
    if (!configuration) return { running: false, state: 'not-started', accountId: account.id, channelId, ownerUserId: directMessageOwnerId, ...(directMessages ? { directMessages: true } : {}), ...(allServers ? { allServers: true } : {}) };
    const saved = await readState(paths.status);
    const supervision = await readState(`${paths.configuration}.supervision.json`);
    const supervisorAlive = processExists(supervision?.pid);
    const supervising = supervision?.enabled && supervisorAlive;
    const pid = configuration.pid || saved?.pid;
    if (stops.has(paths.configuration) || (supervisorAlive && supervision.enabled === false) || (processExists(pid) && ['stopping', 'stopped'].includes(saved?.state))) {
      return { ...(saved || {}), listenerId: configuration.listenerId, running: false, state: 'stopping', shutdownPending: true };
    }
    if (pid && !processExists(pid)) return { ...(saved || {}), running: Boolean(supervising), state: supervising ? 'recovering' : saved?.state === 'failed' ? 'failed' : 'stopped', ...(supervising ? { supervision } : {}) };
    if (!configuration.controlUrl) return { ...(saved || {}), running: false, state: saved?.state || 'starting' };
    try { return await controlRequest(configuration); }
    catch (error) {
      if (saved?.state === 'failed' || saved?.state === 'stopped') return { ...saved, running: false };
      return { ...(saved || {}), running: Boolean(saved?.running), state: 'unreachable', lastError: error.message };
    }
  }

  async function start(options) {
    if (!options.directMessages && !options.allServers) assertSnowflake(options.channelId, 'channelId');
    const account = accountForId(options.accountId);
    const paths = targetPaths(account.id, options.channelId, options.directMessages, options.allServers);
    await ensureStateRoot(root);
    const lockPath = options.directMessages ? `${paths.configuration}.starting` : join(root, `${account.id}-servers.starting`);
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readState(lockPath).catch(() => null);
      if (owner && !processExists(owner.pid)) {
        await rm(lockPath);
        lock = await open(lockPath, 'wx', 0o600);
      } else {
        throw new Error('This channel listener is already starting');
      }
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    try { return await startUnlocked(options); }
    finally { await lock.close(); await rm(lockPath, { force: true }); }
  }

  async function startUnlocked({ guildId, channelId, accountId, directMessages = false, allServers = false, mode = 'mentions', model = replyDefaults.model, reasoningEffort = replyDefaults.reasoningEffort, serviceTier = replyDefaults.serviceTier, batchWindowMs = 500, cooldownMs = 5000, maxRepliesPerMinute = 6, gifUrls = [] }) {
    if (!directMessages && !allServers) {
      assertSnowflake(guildId, 'guildId');
      assertSnowflake(channelId, 'channelId');
    }
    const account = accountForId(accountId);
    const current = await status({ channelId, accountId: account.id, directMessages, allServers });
    if (current.state === 'stopping') throw new Error('The existing listener is still stopping. Wait for shutdown before starting it again.');
    if (current.state === 'unreachable') throw new Error('The existing listener cannot be verified. Check its status before starting another instance.');
    if (current.running) return { ...current, alreadyRunning: true };
    if (!entrypoint) throw new Error('The proactive server entry point is not configured; update the Discord plugin');
    if (!directMessages) await assertNoOverlappingListener(account.id, allServers);
    const channel = allServers ? null : directMessages ? await account.client.createDirectMessageChannel(directMessageOwnerId) : await account.client.getChannel(channelId);
    if (allServers) {
      guildId = undefined; channelId = undefined; mode = 'mentions';
    } else if (directMessages) {
      assertOwnerDirectMessageChannel(channel);
      channelId = channel.id;
      guildId = undefined;
      mode = 'all';
    } else {
      if (channel.guild_id !== guildId) throw new Error('The channel does not belong to the requested server');
      if (![0, 5, 10, 11, 12].includes(channel.type)) throw new Error('Proactive mode needs a text channel or a thread');
    }
    const configuredCommand = process.env.DISCORD_CODEX_COMMAND || process.env.CODEX_CLI_PATH;
    const candidates = configuredCommand ? [configuredCommand] : [
      'codex', join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
      ...(process.platform === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'] : []),
    ];
    const codexCommand = candidates.find((command) => {
      const check = commandCheck(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
      return !check.error && check.status === 0;
    });
    if (!codexCommand) throw new Error('Codex CLI was not found. Set DISCORD_CODEX_COMMAND to its executable path.');
    const authentication = commandCheck(codexCommand, ['login', 'status'], { encoding: 'utf8', timeout: 5000 });
    if (authentication.error || authentication.status !== 0) throw new Error('Codex CLI is not logged in. Run codex login before starting proactive mode.');

    const paths = targetPaths(account.id, channelId, directMessages, allServers);
    await ensureStateRoot(root);
    const configuration = {
      listenerId: randomUUID(), controlToken: randomBytes(32).toString('hex'),
      accountId: account.id, guildId, channelId, mode, ownerUserId: directMessageOwnerId,
      ...(allServers ? { allServers: true } : {}),
      ...(directMessages ? { directMessages: true } : {}),
      model: model || replyDefaults.model, reasoningEffort, serviceTier, codexCommand,
      batchWindowMs, cooldownMs, maxRepliesPerMinute, gifUrls,
    };
    try { await writeFile(paths.configuration, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (current.state === 'starting') throw new Error('This channel listener is already starting');
      await rm(paths.configuration);
      await writeFile(paths.configuration, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
    }
    await writeState(paths.status, { ...current, listenerId: configuration.listenerId, state: 'starting', running: false, accountId: account.id, guildId, channelId, model: configuration.model, reasoningEffort, serviceTier, ownerUserId: directMessageOwnerId, ...(directMessages ? { directMessages: true } : {}), ...(allServers ? { allServers: true } : {}) });
    const log = openSync(paths.log, 'a', 0o600);
    let child;
    try {
      const supervisor = join(dirname(entrypoint), entrypoint.endsWith('.cjs') ? 'supervisor.cjs' : 'supervisor.mjs');
      const supervised = existsSync(supervisor);
      if (supervised) await writeState(`${paths.configuration}.supervision.json`, { enabled: true });
      child = spawnImpl(process.execPath, supervised ? [supervisor, entrypoint, paths.configuration] : [entrypoint, paths.configuration], { detached: true, stdio: ['ignore', log, log], env: process.env });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const latestStatus = await readState(paths.status);
      await writeState(paths.status, { ...latestStatus, pid: child.pid });
      child.unref();
    } catch (error) {
      await writeState(paths.status, { listenerId: configuration.listenerId, state: 'failed', running: false, accountId: account.id, guildId, channelId, lastError: error.message });
      throw error;
    } finally { closeSync(log); }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const configuration = await readState(paths.configuration);
      const saved = await readState(paths.status);
      if (saved?.state === 'failed') throw new Error(saved.lastError || 'Proactive server failed to start');
      if (saved?.state === 'stopped') throw new Error('Proactive startup was stopped');
      if (configuration?.controlUrl) {
        const result = await controlRequest(configuration).catch(() => null);
        if (result?.running) return result;
      }
      await wait(250);
    }

    throw new Error('Proactive server is still starting. Check discord_proactive_status before retrying.');
  }

  async function assertNoOverlappingListener(accountId, allServers) {
    if (!allServers) {
      const broad = await status({ accountId, allServers: true });
      if (broad.running || ['starting', 'stopping', 'unreachable'].includes(broad.state)) throw new Error('All-server mentions are active; stop them before starting a channel listener');
      return;
    }
    for (const filename of await readdir(root)) {
      if (!filename.endsWith('.json') || filename.endsWith('.status.json')) continue;
      const configuration = await readState(join(root, filename));
      if (!configuration || configuration.accountId !== accountId || configuration.directMessages || configuration.allServers) continue;
      const channel = await status({ accountId, channelId: configuration.channelId });
      if (channel.running || ['starting', 'stopping', 'unreachable'].includes(channel.state)) throw new Error('Stop active channel listeners before enabling all-server mentions');
    }
  }

  async function stop({ channelId, accountId, directMessages = false, allServers = false }) {
    if (!directMessages && !allServers) assertSnowflake(channelId, 'channelId');
    const account = accountForId(accountId);
    const paths = targetPaths(account.id, channelId, directMessages, allServers);
    if (stops.has(paths.configuration)) return stops.get(paths.configuration);
    const operation = stopUnlocked(paths, { channelId, accountId: account.id, directMessages, allServers }).finally(() => stops.delete(paths.configuration));
    stops.set(paths.configuration, operation);
    return operation;
  }

  async function stopUnlocked(paths, target) {
    const deadlineAt = Date.now() + shutdownTimeoutMs;
    const configuration = await readState(paths.configuration);
    const saved = await readState(paths.status);
    const supervision = await readState(`${paths.configuration}.supervision.json`);
    const registeredPids = new Set([configuration?.pid, saved?.listenerId === configuration?.listenerId ? saved?.pid : undefined, supervision?.pid].filter((pid) => Number.isSafeInteger(pid) && pid > 0));
    const alive = () => [...registeredPids].some(processExists);
    if (supervision) await writeState(`${paths.configuration}.supervision.json`, { ...supervision, enabled: false });
    if (!alive() && (registeredPids.size || !configuration?.controlUrl)) {
      if (!registeredPids.size && saved?.state === 'starting') throw new Error('The listener is still starting; retry stop shortly');
      return { ...(saved || {}), ...target, listenerId: configuration?.listenerId, running: false, state: configuration ? 'stopped' : 'not-started', ownerUserId: directMessageOwnerId, alreadyStopped: true };
    }
    let result = { ...(saved || {}), ...target, listenerId: configuration?.listenerId, ownerUserId: directMessageOwnerId, running: false, state: 'stopping', shutdownPending: true };
    if (configuration?.listenerId) await writeState(paths.status, result);
    if (configuration?.controlUrl) {
      try { result = { ...result, ...await controlRequest(configuration, 'POST', '/stop', undefined, Math.min(3000, deadlineAt - Date.now())), running: false, state: 'stopping', shutdownPending: true }; }
      catch (error) { result.lastError = `Listener shutdown remains unconfirmed: ${error.message}`; }
    }
    do {
      const latest = await readState(paths.configuration);
      const latestStatus = await readState(paths.status);
      const latestSupervision = await readState(`${paths.configuration}.supervision.json`);
      if (latest && latest.listenerId !== configuration?.listenerId) return { ...result, lastError: 'Listener identity changed during shutdown' };
      for (const pid of [latest?.pid, latestStatus?.listenerId === configuration?.listenerId ? latestStatus?.pid : undefined, latestSupervision?.pid]) if (Number.isSafeInteger(pid) && pid > 0) registeredPids.add(pid);
      if (registeredPids.size && !alive()) {
        const stopped = { ...result, state: 'stopped', shutdownPending: false, stoppedAt: new Date().toISOString() };
        if (latestStatus?.listenerId === configuration?.listenerId) await writeState(paths.status, stopped);
        return stopped;
      }
      if (Date.now() >= deadlineAt) break;
      await wait(Math.min(shutdownPollMs, deadlineAt - Date.now()));
    } while (Date.now() < deadlineAt);
    return result;
  }

  async function control({ channelId, accountId, directMessages = false, allServers = false, ...request }) {
    const account = accountForId(accountId);
    const configuration = await readState(targetPaths(account.id, directMessages ? undefined : channelId, directMessages, allServers).configuration);
    if (!configuration?.controlUrl) throw new Error('This Nova listener is not active');
    return controlRequest(configuration, 'POST', '/control', { ...request, ...(channelId ? { channelId } : {}), userId: directMessageOwnerId });
  }

  return { start, stop, status, control };
}
