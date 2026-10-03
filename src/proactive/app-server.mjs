import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createAppServer({ command, cwd, env, spawnImpl = spawn, onNotification = () => {}, onFailure = () => {} }) {
  const child = spawnImpl(command, [
    'app-server', '--listen', 'stdio://',
    '--disable', 'shell_tool', '--disable', 'plugins', '--disable', 'hooks',
    '--disable', 'memories', '--disable', 'js_repl',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'analytics.enabled=false', '-c', 'otel.log_user_prompt=false',
  ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let exited = false;
  let closing;
  let diagnostics = '';
  const lines = createInterface({ input: child.stdout });

  function fail(error) {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    onFailure(error);
  }

  function send(message) {
    if (closed) throw new Error('The Codex conversation worker is closed');
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  lines.on('line', (line) => {
    if (closed) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Nova cannot execute tools or approval requests' } });
        onFailure(new Error('Codex requested an unsupported tool or approval'));
      } else {
        try { onNotification(message.method, message.params); }
        catch (error) { onFailure(error); }
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', (code) => {
    exited = true;
    const detail = diagnostics.split('\n').filter((line) => /^(?:ERROR|error:)/.test(line)).at(-1)?.slice(0, 200);
    fail(new Error(`Codex conversation worker exited (${code})${detail ? `: ${detail}` : ''}`));
  });

  function request(method, params, timeoutMs = 15000) {
    if (closed) return Promise.reject(new Error('The Codex conversation worker is closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  function close() {
    if (closing) return closing;
    fail(new Error('Codex conversation worker stopped'));
    lines.close();
    if (exited) return closing = Promise.resolve();
    closing = new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    return closing;
  }

  return { request, notify: (method, params) => send({ jsonrpc: '2.0', method, params }), close, isClosed: () => closed };
}
