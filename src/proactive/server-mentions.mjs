import { acceptsListenerMessage, addressesBot, mentionsBot } from './target.mjs';
import { directMessageOwnerId } from './target.mjs';

export function createServerMentions({ botUserId, resolveReplyAuthor, createRuntime, maxIdleConversations = 8, onStatus = () => {} }) {
  const entries = new Map();
  const bindings = new Map();
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
    const key = `${message.guild_id}:${message.channel_id}`;
    const bound = bindings.get(key) === 'all';
    if (!bound && !await addressesBot(message, botUserId, resolve) || stopped) return false;
    const incoming = bound || mentionsBot(message, botUserId) ? message : { ...message, referenceAuthorId: botUserId };
    const runtime = await getRuntime(message.guild_id, message.channel_id);
    if (!runtime || stopped) return false;
    const accepted = await runtime.receive(incoming);
    report();
    void prune().catch(() => {});
    return accepted;
  }

  async function getRuntime(guildId, channelId) {
    if (stopped) throw new Error('Server conversations are stopped');
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId)) throw new Error('Invalid conversation target');
    const key = `${guildId}:${channelId}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { runtime: null, lastUsed: Date.now(), observers: new Set() };
      entries.set(key, entry);
      entry.ready = Promise.resolve().then(() => createRuntime(guildId, channelId, () => {
        report();
        if (entry.runtime) for (const observer of entry.observers) observer(entry.runtime.status());
        void prune().catch(() => {});
      })).then(async (runtime) => {
        entry.runtime = runtime;
        if (stopped) { await runtime.close(); return null; }
        if (bindings.get(key) === 'all') await runtime.control?.({ action: 'mode', value: 'all', userId: directMessageOwnerId });
        return runtime;
      }).catch((error) => { if (entries.get(key) === entry) entries.delete(key); throw error; });
    }
    entry.lastUsed = Date.now();
    return entry.ready;
  }

  async function bindThread(guildId, channelId, observer) {
    const key = `${guildId}:${channelId}`;
    bindings.set(key, 'all');
    const runtime = await getRuntime(guildId, channelId);
    await runtime.control?.({ action: 'mode', value: 'all', userId: directMessageOwnerId });
    if (observer) entries.get(key).observers.add(observer);
    return runtime;
  }

  async function removeRuntime(guildId, channelId) {
    const key = `${guildId}:${channelId}`;
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    await (await entry.ready)?.close();
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

  return { receive, status, close, getRuntime, bindThread, removeRuntime };
}
