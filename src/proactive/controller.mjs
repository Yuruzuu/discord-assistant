import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { assertSnowflake } from '../discord-url.mjs';
import { ensureStateRoot, listenerPaths, directMessagePaths, readState, writeState, proactiveRoot } from './state.mjs';
import { assertOwnerDirectMessageChannel, directMessageOwnerId } from './target.mjs';

async function defaultModel() {
  try {
    const text = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8');
    const root = text.split(/^\[/m)[0];
    const value = root.match(/^model\s*=\s*("(?:[^"\\]|\\.)*")/m)?.[1];
    return value ? JSON.parse(value) : undefined;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function controlRequest(configuration, method = 'GET', route = '/status') {
  const url = new URL(configuration.controlUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid listener control address');
  const response = await fetch(new URL(route, url), {
    method, headers: { Authorization: `Bearer ${configuration.controlToken}` }, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Listener control request failed (${response.status})`);
  const status = await response.json();
  if (status.listenerId !== configuration.listenerId) throw new Error('Listener identity does not match');

  return status;
}

export function createProactiveController(service, { entrypoint = process.env.DISCORD_PROACTIVE_ENTRYPOINT || service.proactiveEntrypoint, root = proactiveRoot(), spawnImpl = spawn, commandCheck = spawnSync } = {}) {
  function accountForId(accountId) { return accountId ? service.accountById(accountId) : service.accounts[0]; }
  function targetPaths(accountId, channelId, directMessages) {
    return directMessages ? directMessagePaths(accountId, root) : listenerPaths(accountId, channelId, root);
  }
  function processExists(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  }

  async function status({ channelId, accountId, directMessages = false } = {}) {
    if (!directMessages) assertSnowflake(channelId, 'channelId');
    const account = accountForId(accountId);
    const paths = targetPaths(account.id, channelId, directMessages);
    const configuration = await readState(paths.configuration);
    if (!configuration) return { running: false, state: 'not-started', accountId: account.id, channelId, ...(directMessages ? { directMessages: true, ownerUserId: directMessageOwnerId } : {}) };
    const saved = await readState(paths.status);
    const pid = configuration.pid || saved?.pid;
    if (pid && !processExists(pid)) return { ...(saved || {}), running: false, state: saved?.state === 'failed' ? 'failed' : 'stopped' };
    if (!configuration.controlUrl) return { ...(saved || {}), running: false, state: pid && !processExists(pid) ? 'failed' : saved?.state || 'starting' };
    try { return await controlRequest(configuration); }
    catch (error) {
      if (saved?.state === 'failed' || saved?.state === 'stopped') return { ...saved, running: false };
      return { ...(saved || {}), running: Boolean(saved?.running), state: 'unreachable', lastError: error.message };
    }
  }

  async function start(options) {
    if (!options.directMessages) assertSnowflake(options.channelId, 'channelId');
    const account = accountForId(options.accountId);
    const paths = targetPaths(account.id, options.channelId, options.directMessages);
    await ensureStateRoot(root);
    const lockPath = `${paths.configuration}.starting`;
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

  async function startUnlocked({ guildId, channelId, accountId, directMessages = false, mode = 'mentions', model, reasoningEffort = 'low', batchWindowMs = 1500, cooldownMs = 5000, maxRepliesPerMinute = 6, gifUrls = [] }) {
    if (!directMessages) {
      assertSnowflake(guildId, 'guildId');
      assertSnowflake(channelId, 'channelId');
    }
    const account = accountForId(accountId);
    const current = await status({ channelId, accountId: account.id, directMessages });
    if (current.state === 'unreachable') throw new Error('The existing listener cannot be verified. Check its status before starting another instance.');
    if (current.running) return { ...current, alreadyRunning: true };
    if (!entrypoint) throw new Error('The proactive server entry point is not configured; update the Discord plugin');
    const channel = directMessages ? await account.client.createDirectMessageChannel(directMessageOwnerId) : await account.client.getChannel(channelId);
    if (directMessages) {
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

    const paths = targetPaths(account.id, channelId, directMessages);
    await ensureStateRoot(root);
    const configuration = {
      listenerId: randomUUID(), controlToken: randomBytes(32).toString('hex'),
      accountId: account.id, guildId, channelId, mode,
      ...(directMessages ? { directMessages: true, ownerUserId: directMessageOwnerId } : {}),
      model: model || await defaultModel(), reasoningEffort, codexCommand,
      batchWindowMs, cooldownMs, maxRepliesPerMinute, gifUrls,
    };
    try { await writeFile(paths.configuration, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (current.state === 'starting') throw new Error('This channel listener is already starting');
      await rm(paths.configuration);
      await writeFile(paths.configuration, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
    }
    await writeState(paths.status, { ...current, listenerId: configuration.listenerId, state: 'starting', running: false, accountId: account.id, guildId, channelId, model: configuration.model, ...(directMessages ? { directMessages: true, ownerUserId: directMessageOwnerId } : {}) });
    const log = openSync(paths.log, 'a', 0o600);
    let child;
    try {
      child = spawnImpl(process.execPath, [entrypoint, paths.configuration], { detached: true, stdio: ['ignore', log, log], env: process.env });
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

  async function stop({ channelId, accountId, directMessages = false }) {
    if (!directMessages) assertSnowflake(channelId, 'channelId');
    const account = accountForId(accountId);
    const paths = targetPaths(account.id, channelId, directMessages);
    const configuration = await readState(paths.configuration);
    if (!configuration?.controlUrl) {
      const current = await status({ channelId, accountId: account.id, directMessages });
      if (current.state === 'starting') throw new Error('The listener is still starting; retry stop shortly');
      return { ...current, alreadyStopped: true };
    }
    try { return await controlRequest(configuration, 'POST', '/stop'); }
    catch (error) {
      const current = await status({ channelId, accountId: account.id, directMessages });
      if (current.running || current.state === 'unreachable') throw new Error(`Listener stop could not be confirmed: ${error.message}`);
      return { ...current, alreadyStopped: true };
    }
  }

  return { start, stop, status };
}
