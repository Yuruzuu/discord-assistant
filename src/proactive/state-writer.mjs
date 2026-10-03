export function createStateWriter(write, { intervalMs = 250, onError = () => {} } = {}) {
  let latest;
  let scheduled;
  let writing;

  async function drain() {
    while (latest !== undefined) {
      const snapshot = latest;
      latest = undefined;
      await write(snapshot);
    }
  }

  function scheduleFlush() {
    if (scheduled || writing || latest === undefined) return;
    scheduled = setTimeout(() => { void flush().catch(onError); }, intervalMs);
  }

  function flush(value) {
    if (value !== undefined) latest = value;
    clearTimeout(scheduled);
    scheduled = undefined;
    if (!writing) {
      writing = Promise.resolve().then(drain).finally(() => {
        writing = undefined;
        scheduleFlush();
      });
    }
    return writing.then(() => latest === undefined ? undefined : flush());
  }

  function schedule(value) {
    latest = value;
    scheduleFlush();
  }

  return { schedule, flush };
}
