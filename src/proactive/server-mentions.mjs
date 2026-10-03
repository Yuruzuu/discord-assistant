import { acceptsListenerMessage, addressesBot, mentionsBot } from './target.mjs';

export function createServerMentions({ botUserId, resolveReplyAuthor, createRuntime, maxIdleConversations = 8, onStatus = () => {} }) {
  const entries = new Map();
  let stopped = false;
  let pruning = Promise.resolve();

  function status() {
    return { conversations: [...entries.values()].filter((entry) => entry.runtime).map((entry) => entry.runtime.status()), pendingConversations: [...entries.values()].filter((entry) => !entry.runtime).length };
  }

  function report() { onStatus(status()); }

  function prune() {
    pruning = pruning.catch(() => {}).then(async () => {
      if (stopped) return;
      const idle = [...entries.entries()].filter(([, entry]) => {
        const statistics = entry.runtime?.status().statistics;
        return statistics && !statistics.generating && !statistics.queued;
      }).sort((left, right) => left[1].lastUsed - right[1].lastUsed);
      for (const [key, entry] of idle.slice(0, Math.max(0, idle.length - maxIdleConversations))) {
        if (entries.get(key) !== entry) continue;
        const statistics = entry.runtime.status().statistics;
        if (statistics.generating || statistics.queued) continue;
        entries.delete(key);
        await entry.runtime.close();
      }
      report();
    });
    return pruning;
  }

  async function receive(message) {
    if (stopped || !acceptsListenerMessage({ allServers: true }, message)) return false;
    const resolve = (messageId) => resolveReplyAuthor(message.channel_id, messageId);
    if (!await addressesBot(message, botUserId, resolve) || stopped) return false;
    const incoming = mentionsBot(message, botUserId) ? message : { ...message, referenceAuthorId: botUserId };
    const key = `${message.guild_id}:${message.channel_id}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { runtime: null, lastUsed: Date.now() };
      entries.set(key, entry);
      entry.ready = Promise.resolve().then(() => createRuntime(message.guild_id, message.channel_id, () => { report(); void prune(); })).then(async (runtime) => {
        entry.runtime = runtime;
        if (stopped) { await runtime.close(); return null; }
        return runtime;
      }).catch((error) => { if (entries.get(key) === entry) entries.delete(key); throw error; });
    }
    entry.lastUsed = Date.now();
    const runtime = await entry.ready;
    if (!runtime || stopped) return false;
    const accepted = await runtime.receive(incoming);
    report();
    void prune();
    return accepted;
  }

  async function close() {
    stopped = true;
    const current = [...entries.values()];
    entries.clear();
    await Promise.allSettled(current.map(async (entry) => {
      const runtime = await entry.ready;
      if (runtime) await runtime.close();
    }));
    await pruning.catch(() => {});
  }

  return { receive, status, close };
}
