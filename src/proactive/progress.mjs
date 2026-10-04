const activities = {
  discord_list_servers: { category: 'servers', content: 'i’m checking the Discord servers i can access.' },
  discord_list_channels: { category: 'channels', content: 'i’m finding the relevant Discord channels.' },
  discord_find_members: { category: 'members', content: 'i’m looking up the matching Discord members.' },
  discord_search_messages: { category: 'search', content: 'i’m searching the Discord chats now.' },
  discord_message_context: { category: 'context', content: 'i’m reading the surrounding messages for context.' },
  discord_browse_messages: { category: 'context', content: 'i’m reading more of the Discord conversation.' },
  discord_user_info: { category: 'profile', content: 'i’m checking that Discord profile.' },
  voice_transcribe: { category: 'voice transcription', content: 'i’m transcribing your voice note.' },
  image_read: { category: 'images', content: 'i’m loading the attached images.' },
  reply_context: { category: 'reply context', content: 'i’m loading the message you replied to.' },
  web_read_link: { category: 'linked page', content: 'i’m reading that linked page.' },
  project_list: { category: 'projects', content: 'i’m checking the approved projects.' },
  project_search: { category: 'project search', content: 'i’m searching the approved project files.' },
  project_read_file: { category: 'project file', content: 'i’m reading that approved project file.' },
  discord_research_topic: { category: 'topic research', content: 'i’m researching that topic in the Discord discussions.' },
  read_tool_result: { category: 'stored results', content: 'i’m reviewing more of the tool results.' },
};

export function createProgressReporter({ send, edit, remove, signal, now = Date.now, intervalMs = 1500, maxMessages = 3, onSent = () => {}, onError = () => {} }) {
  const cancellation = new AbortController();
  const seen = new Set();
  const startedAt = new Map();
  let queued = Promise.resolve();
  let attempted = 0;
  let lastAttemptAt = -Infinity;
  let closed = false;
  let receipt;
  let displayed;
  let lastEditAt = -Infinity;
  const details = [];

  async function reportEditable(event, deliverySignal) {
    const activity = Object.hasOwn(activities, event?.toolName) ? activities[event.toolName] : null;
    if (!activity || !['started', 'completed', 'failed'].includes(event.stage)) return;
    const timestamp = now();
    if (event.stage === 'started') startedAt.set(event.toolName, timestamp);
    const elapsedMs = Math.max(0, timestamp - (startedAt.get(event.toolName) ?? timestamp));
    const resultCount = Number.isSafeInteger(event.resultCount) && event.resultCount >= 0 ? event.resultCount : undefined;
    details.push({ toolName: event.toolName, stage: event.stage, elapsedMs, ...(resultCount === undefined ? {} : { resultCount }) });
    if (details.length > 50) details.shift();
    let content = activity.content;
    if (event.stage === 'completed') content = `finished ${activity.category}${resultCount === undefined ? '' : `; found ${resultCount} ${resultCount === 1 ? 'result' : 'results'}`}${elapsedMs >= 1000 ? ` (${Math.round(elapsedMs / 1000)}s)` : ''}.`;
    if (event.stage === 'failed') content = 'that lookup failed; i don’t have those results yet.';
    if (content === displayed || (event.stage !== 'failed' && receipt && timestamp - lastEditAt < intervalMs && !(event.stage === 'completed' && activity.category === 'search'))) return;
    if (!receipt && attempted >= maxMessages) return;
    const sendSignal = AbortSignal.any([cancellation.signal, signal, deliverySignal].filter(Boolean));
    try {
      sendSignal.throwIfAborted();
      if (receipt) await edit(receipt, content, sendSignal);
      else { attempted += 1; receipt = await send(content, sendSignal, 0); onSent(receipt); }
      displayed = content;
      lastEditAt = timestamp;
    } catch (error) { if (!sendSignal.aborted) onError(error); }
  }

  async function report(event, deliverySignal) {
    if (closed || signal?.aborted || deliverySignal?.aborted || attempted >= maxMessages) return;
    if (edit) return reportEditable(event, deliverySignal);
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
    details: () => details.map((entry) => ({ ...entry })),
    finish: async ({ failed = false, cancelled = false, signal: finishSignal } = {}) => {
      closed = true;
      cancellation.abort();
      await queued;
      if (!receipt || finishSignal?.aborted) return;
      try {
        if (cancelled) await edit?.(receipt, 'stopped this answer.', finishSignal);
        else if (failed) await edit?.(receipt, 'that answer stopped before it finished. use /nova status for details or try again.', finishSignal);
        else if (remove) await remove(receipt, finishSignal);
        else await edit?.(receipt, 'finished checking.', finishSignal);
      } catch (error) { if (!finishSignal?.aborted) onError(error); }
    },
  };
}
