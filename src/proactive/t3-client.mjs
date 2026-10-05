import WebSocket from 'ws';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeState } from './state.mjs';

const execute = promisify(execFile);
export const t3CredentialPath = () => join(homedir(), '.config', 'discord-mcp', 't3-session.json');
const defaultApplication = '/Applications/T3 Code (Nightly).app';

export async function configureT3Connection({ applicationPath = defaultApplication, filename = t3CredentialPath(), baseDirectory = join(homedir(), '.t3'), ttl = '30d' } = {}) {
  const binary = join(applicationPath, 'Contents', 'MacOS', applicationPath.split('/').at(-1).replace(/\.app$/, ''));
  const entrypoint = join(applicationPath, 'Contents', 'Resources', 'app.asar', 'apps', 'server', 'dist', 'bin.mjs');
  const { stdout } = await execute(binary, [entrypoint, 'auth', 'session', 'issue', '--base-dir', baseDirectory, '--ttl', ttl, '--subject', 'nova-discord', '--label', 'Nova Discord handoffs', '--json'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000, maxBuffer: 1024 * 1024,
  }).catch(() => { throw new Error('T3 could not issue a dedicated Nova session'); });
  const issued = JSON.parse(stdout);
  if (typeof issued.token !== 'string' || typeof issued.sessionId !== 'string') throw new Error('T3 did not return a valid dedicated session');
  await mkdir(join(filename, '..'), { recursive: true, mode: 0o700 });
  await writeState(filename, { sessionId: issued.sessionId, token: issued.token, expiresAt: issued.expiresAt, baseDirectory });
  return { connected: true, expiresAt: issued.expiresAt, credentialPath: filename };
}

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('T3 handoffs require a local loopback server');
  return url.origin;
}

export function createT3Client({ filename = t3CredentialPath(), fetchImplementation = fetch, socketFactory = (url) => new WebSocket(url, { maxPayload: 16 * 1024 * 1024 }), timeoutMs = 15000 } = {}) {
  let socket, connecting, closed = false, number = 0;
  const pending = new Map();
  function failConnection() {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject?.(new Error('T3 connection closed; the operation was not retried')); }
    pending.clear(); socket = null;
  }
  async function connect() {
    if (closed) throw new Error('T3 handoffs are closed');
    if (socket?.readyState === 1) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const metadata = await stat(filename).catch(() => { throw new Error('Connect Nova to T3 Code before using task handoffs'); });
      if ((metadata.mode & 0o077) !== 0) throw new Error('T3 session credentials must be owner-readable only');
      const credential = JSON.parse(await readFile(filename, 'utf8'));
      if (!credential.token || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())) throw new Error('Reconnect Nova to T3 Code; its dedicated session has expired');
      const runtime = JSON.parse(await readFile(join(credential.baseDirectory || join(homedir(), '.t3'), 'userdata', 'server-runtime.json'), 'utf8').catch(() => { throw new Error('Start T3 Code before using task handoffs'); }));
      const origin = localOrigin(runtime.origin);
      const response = await fetchImplementation(`${origin}/api/auth/websocket-ticket`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`T3 session authentication failed (${response.status}); reconnect Nova to T3 Code`);
      const { ticket } = await response.json();
      if (typeof ticket !== 'string') throw new Error('T3 did not issue a websocket ticket');
      if (closed) throw new Error('T3 handoffs are closed');
      const current = socketFactory(`${origin.replace(/^http:/, 'ws:')}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
      socket = current;
      current.on('error', () => {});
      current.on('close', () => { if (socket === current) failConnection(); });
      current.on('message', (data) => {
        let messages;
        try { messages = [JSON.parse(String(data))].flat(); } catch { current.close(); return; }
        for (const message of messages) {
          if (message._tag === 'Ping') { current.send(JSON.stringify({ _tag: 'Pong' })); continue; }
          const request = pending.get(String(message.requestId));
          if (message._tag === 'Defect' || message._tag === 'ClientProtocolError') { current.close(); continue; }
          if (!request) continue;
          if (message._tag === 'Chunk') {
            request.queue = (request.queue || Promise.resolve()).then(async () => { for (const value of message.values || []) await request.onValue?.(value); }).catch(() => {}).finally(() => { if (current.readyState === 1) current.send(JSON.stringify({ _tag: 'Ack', requestId: message.requestId })); });
          } else if (message._tag === 'Exit') {
            clearTimeout(request.timer); pending.delete(String(message.requestId));
            if (message.exit?._tag === 'Success') request.resolve?.(message.exit.value);
            else request.reject?.(new Error('T3 rejected this operation; inspect the task in T3 Code'));
          }
        }
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { current.close(); reject(new Error('T3 connection timed out')); }, timeoutMs);
        current.once('open', () => { clearTimeout(timer); resolve(); });
        current.once('error', () => { clearTimeout(timer); reject(new Error('T3 connection failed')); });
      });
    })().finally(() => { connecting = null; });
    return connecting;
  }
  async function request(tag, payload = {}, onValue) {
    await connect();
    const id = String(++number);
    if (onValue) {
      pending.set(id, { onValue });
      try { socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] })); }
      catch { pending.delete(id); throw new Error('T3 request could not be sent'); }
      return () => { pending.delete(id); if (socket?.readyState === 1) socket.send(JSON.stringify({ _tag: 'Interrupt', requestId: id })); };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('T3 operation timed out; check T3 before retrying')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] })); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error('T3 request could not be sent; the operation was not retried')); }
    });
  }
  async function projects() {
    return new Promise((resolve, reject) => {
      let stop;
      const timer = setTimeout(() => { stop?.(); reject(new Error('T3 project catalog timed out')); }, timeoutMs);
      request('orchestration.subscribeShell', {}, (value) => { if (value.kind !== 'snapshot') return; clearTimeout(timer); resolve(value.snapshot.projects || []); stop?.(); }).then((cancel) => { stop = cancel; }).catch((error) => { clearTimeout(timer); reject(error); });
    });
  }
  return { request, projects, subscribe: (threadId, onValue) => request('orchestration.subscribeThread', { threadId, acceptBoundedSnapshot: true }, onValue), close: async () => { closed = true; socket?.close(); failConnection(); await connecting?.catch(() => {}); } };
}
