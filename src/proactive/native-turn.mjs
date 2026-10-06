const terminalStates = new Set(['completed', 'failed', 'interrupted']);

export async function waitForTurnOperation(operation, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

export function createNativeTurn() {
  let turnId;
  let outcome;
  const early = new Map();
  let resolve;
  const terminal = new Promise((accept) => { resolve = accept; });
  let admit;
  const bound = new Promise((accept) => { admit = accept; });
  function settle(value) { if (!outcome) { outcome = value; resolve(value); } return outcome; }
  function bind(id) {
    if (typeof id !== 'string' || !id || id.length > 200) throw Object.assign(new Error('Codex did not confirm a valid native turn identity'), { code: 'NOVA_NATIVE_PROTOCOL', novaFatal: true });
    if (turnId && turnId !== id) throw Object.assign(new Error('Native turn identity changed during execution'), { code: 'NOVA_NATIVE_PROTOCOL', novaFatal: true });
    turnId = id;
    admit(id);
    if (early.has(id)) settle(early.get(id));
    return outcome;
  }
  function observe(value) {
    if (!value || typeof value.id !== 'string' || !terminalStates.has(value.status)) return null;
    const entry = { id: value.id, status: value.status };
    if (!turnId) { if (!early.has(value.id)) early.set(value.id, entry); if (early.size > 4) early.delete(early.keys().next().value); return null; }
    return value.id === turnId ? settle(entry) : null;
  }
  async function wait(timeoutMs) {
    if (outcome) return outcome;
    let timer;
    try { return await Promise.race([terminal, new Promise((accept) => { timer = setTimeout(() => accept(null), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  return { bind, observe, wait, terminal, bound, id: () => turnId, outcome: () => outcome };
}
