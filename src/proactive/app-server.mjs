import { spawn } from 'node:child_process';

const DEFAULT_LIMITS = Object.freeze({ frameBytes: 32 * 1024 * 1024, queuedBytes: 64 * 1024 * 1024, pendingBytes: 64 * 1024 * 1024, inboundBytes: 64 * 1024 * 1024, pendingRequests: 128, inboundCalls: 128 });

export function appServerTimeout(method) {
  if (method === 'thread/compact/start') return 120000;
  if (method === 'turn/interrupt') return 5000;
  if (method === 'initialize' || method === 'thread/start' || /^(?:account\/|model\/|config\/|mcpServerStatus\/)/.test(method)) return 60000;
  return 15000;
}

export function createAppServer({ command, cwd, env, spawnImpl = spawn, onNotification = () => {}, onToolCall, onFailure = () => {}, onLateResponse = () => {}, limits = {} }) {
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(bounds)) if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid Codex transport limit: ${name}`);
  const child = spawnImpl(command, [
    'app-server', '--listen', 'stdio://',
    '--disable', 'shell_tool', '--disable', 'plugins', '--disable', 'hooks',
    '--disable', 'memories', '--disable', 'js_repl',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'analytics.enabled=false', '-c', 'otel.log_user_prompt=false',
  ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const abandoned = new Map();
  const writes = [];
  let nextId = 0;
  let closed = false;
  let exited = false;
  let closing;
  let writing = false;
  let activeWrite;
  let queuedBytes = 0;
  let pendingBytes = 0;
  let inboundCalls = 0;
  let inboundBytes = 0;
  let frameChunks = [];
  let frameBytes = 0;

  function transportError(message, code, request, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    if (request) Object.assign(error, { method: request.method, requestId: request.id, writeOutcome: request.writeOutcome });
    return error;
  }

  function report(error, parameters) {
    try { Promise.resolve(onFailure(error, parameters)).catch(() => {}); } catch {}
  }

  function clearRequest(request) {
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
  }

  function releaseBytes(request) {
    pendingBytes -= request.bytes || 0;
    request.bytes = 0;
  }

  function fail(error) {
    if (closed) return;
    closed = true;
    frameChunks = []; frameBytes = 0;
    for (const request of pending.values()) {
      clearRequest(request);
      request.reject(transportError(error.message, error.code || 'CODEX_TRANSPORT_CLOSED', request));
    }
    pending.clear(); abandoned.clear();
    pendingBytes = 0;
    for (const write of writes.splice(0)) write.reject(error);
    activeWrite?.reject(error);
    queuedBytes = 0;
    report(error);
  }

  function pumpWrites() {
    if (writing || closed || !writes.length) return;
    writing = true;
    const write = writes.shift();
    activeWrite = write;
    // Requests cancelled while queued never reach the process.
    if (write.request && !pending.has(write.request.id)) {
      queuedBytes -= write.buffer.length; writing = false;
      activeWrite = undefined;
      write.reject(transportError('Codex request cancelled before write', 'CODEX_REQUEST_ABORTED', write.request));
      pumpWrites(); return;
    }
    if (write.request) write.request.writeOutcome = 'unknown';
    let callbackFinished = false;
    let drained = true;
    let returned = false;
    let finished = false;
    function finish() {
      if (finished || !returned || !callbackFinished || !drained) return;
      finished = true;
      child.stdin.removeListener('drain', onDrain);
      if (closed) return;
      queuedBytes -= write.buffer.length;
      writing = false;
      activeWrite = undefined;
      if (write.request) write.request.writeOutcome = 'written';
      write.resolve();
      pumpWrites();
    }
    function onDrain() { drained = true; finish(); }
    child.stdin.once('drain', onDrain);
    try {
      drained = child.stdin.write(write.buffer, (error) => {
        if (error) {
          child.stdin.removeListener('drain', onDrain);
          const failure = transportError('Codex stdin write failed; native outcome is unknown', 'CODEX_WRITE_FAILED', write.request);
          write.reject(failure); fail(failure); return;
        }
        callbackFinished = true; finish();
      });
      returned = true;
      finish();
    } catch {
      child.stdin.removeListener('drain', onDrain);
      const error = transportError('Codex stdin write failed; native outcome is unknown', 'CODEX_WRITE_FAILED', write.request);
      write.reject(error); fail(error);
    }
  }

  function send(message, request) {
    if (closed) return Promise.reject(transportError('The Codex conversation worker is closed', 'CODEX_TRANSPORT_CLOSED', request));
    let buffer;
    try { buffer = Buffer.from(JSON.stringify(message) + '\n'); }
    catch { return Promise.reject(transportError('Codex request cannot be serialized', 'CODEX_SERIALIZATION_FAILED', request)); }
    if (buffer.length > bounds.frameBytes || queuedBytes + buffer.length > bounds.queuedBytes) return Promise.reject(transportError('Codex outbound frame or queue exceeds its byte limit', 'CODEX_OUTBOUND_LIMIT', request));
    if (request) {
      if (pendingBytes + buffer.length > bounds.pendingBytes) return Promise.reject(transportError('Codex pending request bytes exceed their limit', 'CODEX_PENDING_LIMIT', request));
      request.bytes = buffer.length;
      pendingBytes += request.bytes;
    }
    return new Promise((resolve, reject) => {
      queuedBytes += buffer.length;
      writes.push({ buffer, request, resolve, reject });
      pumpWrites();
    });
  }

  function dispatch(message, bytes) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid Codex protocol message');
    if (message.id !== undefined && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) throw new Error('Invalid Codex protocol identity');
    if (message.method !== undefined) {
      if (typeof message.method !== 'string' || !message.method) throw new Error('Invalid Codex protocol method');
      if (message.id !== undefined) {
        if (++inboundCalls > bounds.inboundCalls || inboundBytes + bytes > bounds.inboundBytes) throw new Error('Codex inbound tool request limit exceeded');
        inboundBytes += bytes;
        const operation = message.method === 'item/tool/call' && onToolCall
          ? Promise.resolve().then(() => onToolCall(message.params)).then((result) => ({ result }))
          : Promise.resolve({ error: { code: -32601, message: 'Nova cannot execute this tool or approval request' } });
        void operation.catch((error) => {
          report(error, message.params);
          return { error: { code: -32603, message: 'Nova tool failed' } };
        }).then(async (response) => {
          if (!closed) await send({ jsonrpc: '2.0', id: message.id, ...response });
        }).catch((error) => fail(error)).finally(() => { inboundCalls -= 1; inboundBytes -= bytes; });
        if (message.method !== 'item/tool/call' || !onToolCall) report(new Error('Codex requested an unsupported tool or approval'), message.params);
      } else {
        try { Promise.resolve(onNotification(message.method, message.params)).catch((error) => report(error, message.params)); }
        catch (error) { report(error, message.params); }
      }
      return;
    }
    if (message.id === undefined || (!Object.hasOwn(message, 'result') && !message.error)) throw new Error('Invalid Codex protocol response');
    const request = pending.get(message.id) || abandoned.get(message.id);
    if (!request) return;
    request.writeOutcome = 'written';
    if (abandoned.delete(message.id)) {
      releaseBytes(request);
      const response = { method: request.method, params: request.params, result: message.result, error: message.error, requestId: request.id, writeOutcome: request.writeOutcome };
      try { Promise.resolve((request.onLateResponse || onLateResponse)(response)).catch((error) => report(error, request.params)); }
      catch (error) { report(error, request.params); }
      return;
    }
    pending.delete(message.id); clearRequest(request); releaseBytes(request);
    if (message.error) request.reject(transportError(`Codex ${request.method} failed (RPC ${message.error.code ?? 'unknown'})`, 'CODEX_RPC_ERROR', request));
    else request.resolve(message.result);
  }

  child.stdout.on('data', (chunk) => {
    if (closed) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    try {
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start);
        const end = newline < 0 ? buffer.length : newline;
        const part = buffer.subarray(start, end);
        frameBytes += part.length;
        if (frameBytes > bounds.frameBytes) throw new Error('Codex inbound frame exceeds its byte limit');
        if (part.length) frameChunks.push(part);
        if (newline < 0) break;
        if (frameBytes) dispatch(JSON.parse(Buffer.concat(frameChunks, frameBytes).toString('utf8')), frameBytes);
        frameChunks = []; frameBytes = 0;
        start = newline + 1;
      }
    } catch {
      fail(transportError('Codex stdout contained malformed or oversized protocol data', 'CODEX_PROTOCOL_ERROR'));
      child.kill('SIGTERM');
    }
  });
  // Drain stderr without exposing potentially sensitive native diagnostics.
  child.stderr.on('data', () => {});
  child.on('error', () => fail(transportError('Codex conversation worker could not start', 'CODEX_SPAWN_FAILED')));
  child.stdin.on('error', () => fail(transportError('Codex stdin failed', 'CODEX_WRITE_FAILED')));
  child.on('close', (code) => {
    exited = true;
    fail(transportError(`Codex conversation worker exited (${code})`, 'CODEX_TRANSPORT_CLOSED'));
  });

  function request(method, params, options = {}) {
    const settings = typeof options === 'number' ? { timeoutMs: options } : options || {};
    const timeoutMs = Math.min(settings.timeoutMs ?? appServerTimeout(method), settings.deadlineAt === undefined ? Infinity : settings.deadlineAt - Date.now());
    const id = ++nextId;
    const operation = { id, method, params, signal: settings.signal, onLateResponse: settings.onLateResponse, writeOutcome: 'not-written' };
    if (closed) return Promise.reject(transportError('The Codex conversation worker is closed', 'CODEX_TRANSPORT_CLOSED', operation));
    if (pending.size + abandoned.size >= bounds.pendingRequests) return Promise.reject(transportError('Codex pending request limit exceeded', 'CODEX_PENDING_LIMIT', operation));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(transportError('Codex request deadline expired', 'CODEX_REQUEST_TIMEOUT', operation));
    if (operation.signal?.aborted) return Promise.reject(transportError('Codex request cancelled before write', 'CODEX_REQUEST_ABORTED', operation));
    return new Promise((resolve, reject) => {
      Object.assign(operation, { resolve, reject });
      function abandon(code) {
        if (!pending.delete(id)) return;
        clearRequest(operation);
        if (operation.writeOutcome !== 'not-written') abandoned.set(id, operation);
        else releaseBytes(operation);
        reject(transportError(`Codex ${method} ${code === 'CODEX_REQUEST_ABORTED' ? 'cancelled' : 'timed out'}; native outcome ${operation.writeOutcome}`, code, operation));
      }
      operation.abort = () => abandon('CODEX_REQUEST_ABORTED');
      operation.timer = setTimeout(() => abandon('CODEX_REQUEST_TIMEOUT'), timeoutMs);
      pending.set(id, operation);
      operation.signal?.addEventListener('abort', operation.abort, { once: true });
      void send({ jsonrpc: '2.0', id, method, params }, operation).catch((error) => {
        if (!pending.delete(id)) return;
        clearRequest(operation); releaseBytes(operation); reject(error);
      });
    });
  }

  function close() {
    if (closing) return closing;
    fail(transportError('Codex conversation worker stopped', 'CODEX_TRANSPORT_CLOSED'));
    if (exited) return closing = Promise.resolve();
    closing = new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    return closing;
  }

  return {
    request,
    notify(method, params) { return send({ jsonrpc: '2.0', method, params }).catch((error) => { fail(error); throw error; }); },
    close,
    isClosed: () => closed,
  };
}
