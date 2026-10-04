const snowflake = /^\d{17,20}$/;
const appNames = { gmail: 'Gmail', google_drive: 'Google Drive', github: 'GitHub', linear: 'Linear', figma: 'Figma', chatgpt_space: 'ChatGPT Space', sites: 'Sites' };
// Progress text quotes model-chosen arguments, so strip anything that could become mentions, markup or extra lines.
const quote = (value) => `"${String(value).replace(/[\r\n`*_~|<>@#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)}"`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
function listed(items, render, limit = 3) {
  const shown = items.slice(0, limit).map(render);
  if (items.length > limit) shown.push(`${items.length - limit} more`);
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] || '';
}
const ids = (values) => [...new Set((Array.isArray(values) ? values : []).filter((value) => snowflake.test(value)))];
const where = (channelIds) => (ids(channelIds).length ? listed(ids(channelIds), (id) => `<#${id}>`) : 'the server');
const from = (authorIds) => (ids(authorIds).length ? ` from ${listed(ids(authorIds), (id) => `<@${id}>`, 2)}` : '');
const found = (count, word = 'result') => (Number.isSafeInteger(count) ? ` and found ${plural(count, word)}` : '');
function searchSubject(args = {}) {
  const query = typeof args.query === 'string' && args.query.trim() ? ` with ${quote(args.query)}` : '';
  return `${where(args.channelIds)} for messages${query}${from(args.authorIds)}`;
}
function batchSubject(args = {}) {
  const searches = Array.isArray(args.searches) ? args.searches : [];
  const queries = searches.map((search) => search?.query).filter((query) => typeof query === 'string' && query.trim());
  const channels = [...(args.channelIds || []), ...searches.flatMap((search) => search?.channelIds || [])];
  return `${where(channels)} for ${queries.length ? `${plural(queries.length, 'keyword')}: ${listed(queries, quote)}` : plural(searches.length, 'search')}`;
}
function period(args = {}) {
  if (args.day === 'today' || args.day === 'yesterday') return args.day;
  if (args.since) return 'in the requested time window';
  const hours = Number.isFinite(args.hours) ? args.hours : 24;
  return `over the last ${hours === 1 ? 'hour' : `${hours} hours`}`;
}
function activitySubject(args = {}) {
  const keywords = Array.isArray(args.keywords) ? args.keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim()) : [];
  return `${where(args.channelIds)} ${period(args)}${keywords.length ? ` that mentions ${listed(keywords, quote)}` : ''}`;
}
const appName = (tool) => { const app = String(tool || '').split('.')[0]; return appNames[app] || app.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'connected apps'; };
const host = (url) => { try { return new URL(url).hostname; } catch { return 'that link'; } };
const filename = (file) => quote(String(file || 'that file').split(/[\\/]/).at(-1));

const activities = {
  discord_list_servers: { category: 'servers', start: () => 'I’m checking which servers I can see.', done: (_, count) => (Number.isSafeInteger(count) ? `I can see ${plural(count, 'server')}.` : 'I’ve checked the servers I can see.') },
  discord_list_channels: { category: 'channels', start: () => 'I’m looking through the server’s channels.', done: (_, count) => (Number.isSafeInteger(count) ? `I found ${plural(count, 'channel')} and threads to look through.` : 'I’ve looked through the server’s channels.') },
  discord_find_members: { category: 'members', start: (args) => `I’m looking up members matching ${quote(args?.query || '')}.`, done: (args, count) => `I looked up members matching ${quote(args?.query || '')}${found(count, 'match')}.` },
  discord_search_messages: { category: 'search', start: (args) => `I’m currently searching ${searchSubject(args)}.`, done: (args, count) => `I’m currently searching ${searchSubject(args)}${found(count)}.` },
  discord_read_activity: { category: 'search', start: (args) => `I’m reading everything posted in ${activitySubject(args)}.`, done: (args, count) => `I’ve read everything posted in ${activitySubject(args)}${found(count, 'message')}.` },
  discord_search_batch: { category: 'search', start: (args) => `I’m currently searching ${batchSubject(args)}.`, done: (args, count) => `I searched ${batchSubject(args)}${found(count)}.` },
  discord_message_context: { category: 'context', start: (args) => `I’m reading the conversation around that message${snowflake.test(args?.channelId) ? ` in <#${args.channelId}>` : ''}.`, done: (_, count) => (Number.isSafeInteger(count) ? `I’ve read ${plural(count, 'message')} around it.` : 'I’ve read the surrounding conversation.') },
  discord_browse_messages: { category: 'context', start: (args) => `I’m reading more of ${snowflake.test(args?.channelId) ? `<#${args.channelId}>` : 'the conversation'}.`, done: (args, count) => `I’ve read ${Number.isSafeInteger(count) ? plural(count, 'message') : 'more messages'}${snowflake.test(args?.channelId) ? ` from <#${args.channelId}>` : ''}.` },
  discord_user_info: { category: 'profile', start: (args) => `I’m checking ${snowflake.test(args?.userId) ? `<@${args.userId}>’s` : 'that'} profile.`, done: (args) => `I’ve checked ${snowflake.test(args?.userId) ? `<@${args.userId}>’s` : 'that'} profile.` },
  discord_research_topic: { category: 'topic research', start: (args) => `I’m researching ${quote(args?.query || '')} across the server’s discussions.`, done: (args) => `I’ve gathered what people said about ${quote(args?.query || '')}.` },
  voice_transcribe: { category: 'voice transcription', start: () => 'I’m transcribing your voice note.', done: () => 'I’ve transcribed your voice note.' },
  image_read: { category: 'images', start: () => 'I’m looking at the images you sent.', done: () => 'I’ve looked at the images.' },
  reply_context: { category: 'reply context', start: () => 'I’m loading the message you replied to.', done: () => 'I’ve loaded the message you replied to.' },
  web_read_link: { category: 'linked page', start: (args) => `I’m reading ${host(args?.url)}.`, done: (args) => `I’ve read ${host(args?.url)}.` },
  apps_list_tools: { category: 'connected apps', start: (args) => `I’m checking what ${args?.app ? `your ${appName(args.app)}` : 'your connected apps'} can do.`, done: (args) => `I’ve checked ${args?.app ? `your ${appName(args.app)}` : 'your connected apps'}.` },
  apps_call_tool: { category: 'connected app', start: (args) => `I’m checking your ${appName(args?.tool)}.`, done: (args) => `I’ve checked your ${appName(args?.tool)}.` },
  project_list: { category: 'projects', start: () => 'I’m checking your approved projects.', done: () => 'I’ve checked your approved projects.' },
  project_search: { category: 'project search', start: (args) => `I’m searching your project files for ${quote(args?.query || '')}.`, done: (args, count) => `I searched your project files for ${quote(args?.query || '')}${found(count, 'match')}.` },
  project_read_file: { category: 'project file', start: (args) => `I’m reading ${filename(args?.file)} from your project.`, done: (args) => `I’ve read ${filename(args?.file)}.` },
  read_tool_result: { category: 'stored results', start: () => 'I’m going through the rest of those results.', done: () => 'I’ve gone through more of those results.' },
};
const failedText = (activity) => (activity.category === 'search' ? 'That search didn’t go through, so I don’t have those results yet.' : 'That lookup didn’t work, so I don’t have those results yet.');

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
    let content = activity.start(event.arguments);
    if (event.stage === 'completed') content = activity.done(event.arguments, resultCount);
    if (event.stage === 'failed') content = failedText(activity);
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

    let content = activity.start(event.arguments);
    if (event.stage === 'started') startedAt.set(activity.category, timestamp);
    else if (event.stage === 'completed') {
      if (activity.category !== 'search' || !startedAt.has('search') || timestamp - startedAt.get('search') < 5000) return;
      content = activity.done(event.arguments, Number.isSafeInteger(event.resultCount) && event.resultCount >= 0 ? event.resultCount : undefined);
    } else content = failedText(activity);

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
        if (cancelled) await edit?.(receipt, 'Stopped this answer.', finishSignal);
        else if (failed) await edit?.(receipt, 'This answer stopped before it finished. Use /nova status for details or try again.', finishSignal);
        else if (remove) await remove(receipt, finishSignal);
        else await edit?.(receipt, 'Finished checking.', finishSignal);
      } catch (error) { if (!finishSignal?.aborted) onError(error); }
    },
  };
}
