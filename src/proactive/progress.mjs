const activities = {
  discord_list_servers: { category: 'servers', content: 'i’m checking the Discord servers i can access.' },
  discord_list_channels: { category: 'channels', content: 'i’m finding the relevant Discord channels.' },
  discord_find_members: { category: 'members', content: 'i’m looking up the matching Discord members.' },
  discord_search_messages: { category: 'search', content: 'i’m searching the Discord chats now.' },
  discord_message_context: { category: 'context', content: 'i’m reading the surrounding messages for context.' },
  discord_browse_messages: { category: 'context', content: 'i’m reading more of the Discord conversation.' },
  discord_user_info: { category: 'profile', content: 'i’m checking that Discord profile.' },
};

export function createProgressReporter({ send, signal, now = Date.now, intervalMs = 1500, maxMessages = 3, onSent = () => {}, onError = () => {} }) {
  const cancellation = new AbortController();
  const seen = new Set();
  const startedAt = new Map();
  let queued = Promise.resolve();
  let attempted = 0;
  let lastAttemptAt = -Infinity;
  let closed = false;

  async function report(event, deliverySignal) {
    if (closed || signal?.aborted || deliverySignal?.aborted || attempted >= maxMessages) return;
    const activity = Object.hasOwn(activities, event?.toolName) ? activities[event.toolName] : null;
    if (!activity || !['started', 'completed', 'failed'].includes(event.stage)) return;
    const timestamp = now();
    const identity = `${event.stage}:${activity.category}`;
    if (seen.has(identity)) return;

    let content = activity.content;
    if (event.stage === 'started') startedAt.set(activity.category, timestamp);
    else if (event.stage === 'completed') {
      if (activity.category !== 'search' || !startedAt.has('search') || timestamp - startedAt.get('search') < 5000) return;
      content = Number.isSafeInteger(event.resultCount) && event.resultCount >= 0
        ? `the Discord search finished; i found ${event.resultCount} matching ${event.resultCount === 1 ? 'message' : 'messages'}.`
        : 'the Discord search finished.';
    } else content = 'that Discord lookup failed; i don’t have those results yet.';

    const firstSearch = event.stage === 'started' && activity.category === 'search';
    if (timestamp - lastAttemptAt < intervalMs && !firstSearch) return;
    seen.add(identity);
    const index = attempted++;
    lastAttemptAt = timestamp;
    const signals = [cancellation.signal, signal, deliverySignal].filter(Boolean);
    const sendSignal = AbortSignal.any(signals);
    try {
      sendSignal.throwIfAborted();
      const receipt = await send(content, sendSignal, index);
      onSent(receipt);
    } catch (error) {
      if (!sendSignal.aborted) onError(error);
    }
  }

  return {
    receive: (event, deliverySignal) => {
      queued = queued.then(() => report(event, deliverySignal));
      return queued;
    },
    close: () => { closed = true; cancellation.abort(); },
  };
}
