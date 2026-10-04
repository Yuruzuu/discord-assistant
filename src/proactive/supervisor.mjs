import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { readState, writeState } from './state.mjs';

export function isFatalListenerFailure(message = '', exitCode) {
  return [4004, 4014].includes(exitCode) || /invalid[ -]?(?:bot[ -]?)?token|token(?: is)? invalid|authentication failed|unauthorized|disallowed intents|4014|4004|not logged in|invalid_grant|missing.{0,20}token/i.test(String(message));
}

export function listenerControlAddress(configuration) {
  if (typeof configuration?.controlUrl !== 'string' || typeof configuration.controlToken !== 'string') return null;
  let url;
  try { url = new URL(configuration.controlUrl); } catch { return null; }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  return new URL('/status', url);
}

export async function runSupervisor({ childEntrypoint, configurationPath, command = process.execPath, spawnImpl = spawn, read = readState, write = writeState,
  sleep = wait, now = Date.now, fetchImpl = fetch, signal, pid = process.pid, maxRestarts = 5, initialBackoffMs = 1000, maxBackoffMs = 30000,
  pollMs = 1000, disconnectedTimeoutMs = 120000, terminationGraceMs = 3000 } = {}) {
  if (typeof childEntrypoint !== 'string' || !childEntrypoint || typeof configurationPath !== 'string' || !configurationPath.endsWith('.json')) throw new Error('Supervisor requires a child entrypoint and JSON configuration path');
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 20 || [initialBackoffMs, maxBackoffMs, pollMs, disconnectedTimeoutMs, terminationGraceMs].some((value) => !Number.isFinite(value) || value < 1 || value > 3600000)) throw new Error('Supervisor restart limits and deadlines must be bounded positive values');
  const sidecarPath = `${configurationPath}.supervision.json`;
  const statusPath = configurationPath.replace(/\.json$/, '.status.json');
  let restarts = 0;
  let child;
  let activeExit;
  let configuration = await read(configurationPath);
  if (!configuration) throw new Error('Listener configuration is unavailable');
  const enabled = async () => !signal?.aborted && (await read(sidecarPath))?.enabled === true;
  if (!await enabled()) return { state: 'stopped', restarts };
  await write(sidecarPath, { enabled: true, pid, startedAt: now() });

  async function report(state, reason) {
    const previous = await read(statusPath).catch(() => null);
    const metadata = Object.fromEntries(['listenerId', 'accountId', 'guildId', 'channelId', 'directMessages', 'allServers', 'ownerUserId'].filter((key) => configuration[key] !== undefined).map((key) => [key, configuration[key]]));
    await write(statusPath, { ...(previous || {}), ...metadata, running: false, state, supervisorPid: pid, restartCount: restarts, lastError: reason || null, updatedAt: new Date(now()).toISOString() });
  }

  async function terminate(exit) {
    if (!child || exit.settled) return;
    child.kill('SIGTERM');
    await Promise.race([exit.promise, sleep(terminationGraceMs)]);
    if (!exit.settled) { child.kill('SIGKILL'); await Promise.race([exit.promise, sleep(terminationGraceMs)]); }
    if (!exit.settled) throw new Error('The previous listener could not be confirmed stopped');
  }

  async function backoff(delay) {
    const until = now() + delay;
    while (now() < until) {
      if (!await enabled()) return false;
      await sleep(Math.min(pollMs, until - now()));
    }
    return enabled();
  }

  try {
    while (await enabled()) {
      let settle;
      const exit = { settled: false, result: null, promise: new Promise((resolve) => { settle = resolve; }) };
      activeExit = exit;
      const finished = (result) => { if (!exit.settled) { exit.settled = true; exit.result = result; settle(result); } };
      try {
        child = spawnImpl(command, [childEntrypoint, configurationPath], { env: process.env, stdio: 'inherit' });
        child.once('error', () => finished({ spawnError: true }));
        child.once('close', (code, exitSignal) => finished({ code, signal: exitSignal }));
      } catch { finished({ spawnError: true }); }
      let disconnectedSince = null;
      let watchdog = false;
      while (!exit.settled) {
        if (!await enabled()) { await terminate(exit); await report('stopped'); return { state: 'stopped', restarts }; }
        configuration = await read(configurationPath) || configuration;
        const address = listenerControlAddress(configuration);
        if (address) {
          try {
            const response = await fetchImpl(address, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${configuration.controlToken}` }, signal: AbortSignal.timeout(3000) });
            if (response.ok) {
              const status = await response.json();
              if (status.listenerId === configuration.listenerId) {
                if (status.gateway?.connected === false && status.state === 'running') disconnectedSince ??= now();
                else if (status.gateway?.connected === true) disconnectedSince = null;
              }
            }
          } catch {}
        }
        if (disconnectedSince !== null && now() - disconnectedSince >= disconnectedTimeoutMs) { watchdog = true; await terminate(exit); break; }
        await Promise.race([exit.promise, sleep(pollMs)]);
      }
      if (!await enabled()) { await report('stopped'); return { state: 'stopped', restarts }; }
      const latest = await read(statusPath).catch(() => null);
      const result = exit.result || {};
      if (!watchdog && (result.code === 0 || ['SIGTERM', 'SIGINT'].includes(result.signal))) { await report('stopped'); return { state: 'stopped', restarts }; }
      if (result.spawnError || isFatalListenerFailure(latest?.lastError, result.code)) { await report('failed', result.spawnError ? 'The listener process could not start.' : 'Listener authentication or Discord intents require attention.'); return { state: 'failed', restarts }; }
      if (restarts >= maxRestarts) { await report('failed', 'Listener recovery reached its restart limit. Start it again explicitly after checking the connection.'); return { state: 'failed', restarts }; }
      restarts += 1;
      await report('recovering', watchdog ? 'Discord stayed disconnected; reconnecting the listener.' : 'The listener exited unexpectedly; reconnecting with bounded backoff.');
      if (!await backoff(Math.min(maxBackoffMs, initialBackoffMs * 2 ** (restarts - 1)))) { await report('stopped'); return { state: 'stopped', restarts }; }
    }
    await report('stopped');
    return { state: 'stopped', restarts };
  } finally {
    if (activeExit) await terminate(activeExit);
    child = null;
    const current = await read(sidecarPath).catch(() => null);
    if (current?.pid === pid) await write(sidecarPath, { enabled: false, pid, stoppedAt: now(), restartCount: restarts });
  }
}

if (process.argv[1] && /(?:^|[\\/])supervisor\.(?:mjs|cjs)$/.test(process.argv[1])) {
  const cancellation = new AbortController();
  process.once('SIGTERM', () => cancellation.abort());
  process.once('SIGINT', () => cancellation.abort());
  runSupervisor({ childEntrypoint: process.argv[2], configurationPath: process.argv[3], signal: cancellation.signal }).catch(() => {
    process.stderr.write('[discord-supervisor] Listener supervision failed. Check the private listener status.\n');
    process.exitCode = 1;
  });
}
