export function startTypingIndicator(sendTyping, { signal, intervalMs = 7000 } = {}) {
  const cancellation = new AbortController();
  const typingSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  let timer;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    cancellation.abort();
    signal?.removeEventListener('abort', stop);
  }

  async function pulse() {
    if (stopped) return;
    try { await sendTyping(typingSignal); }
    catch { /* Typing failures must not interrupt the reply. */ }
    if (!stopped) timer = setTimeout(pulse, intervalMs);
  }

  signal?.addEventListener('abort', stop, { once: true });
  if (typingSignal.aborted) stop();
  else void pulse();

  return stop;
}
