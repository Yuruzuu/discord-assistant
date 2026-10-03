export function createConcurrencyLimit(maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Concurrency must be a positive integer');

  const pending = [];
  let active = 0;

  function startPending() {
    while (active < maximum && pending.length > 0) {
      const request = pending.shift();
      active += 1;
      Promise.resolve()
        .then(request.operation)
        .then(request.resolve, request.reject)
        .finally(() => {
          active -= 1;
          startPending();
        });
    }
  }

  return (operation) => new Promise((resolve, reject) => {
    pending.push({ operation, resolve, reject });
    startPending();
  });
}

export async function mapConcurrent(items, maximum, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker() {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workers = await Promise.allSettled(Array.from({ length: Math.min(maximum, items.length) }, worker));
  const failure = workers.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;

  return results;
}
