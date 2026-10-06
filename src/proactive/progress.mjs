import { commandTrace, sanitizeCommand } from './command-trace.mjs';

const snowflake = /^\d{17,20}$/;
const appNames = { gmail: 'Gmail', google_drive: 'Google Drive', github: 'GitHub', linear: 'Linear', figma: 'Figma', chatgpt_space: 'ChatGPT Space', sites: 'Sites' };
// Progress text quotes model-chosen arguments, so strip anything that could become mentions, markup or extra lines.
const quote = (value) => `"${sanitizeCommand(value).replace(/[\r\n`*_~|<>@#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)}"`;
const plural = (count, word) => `*${count}* ${word}${count === 1 ? '' : 's'}`;
function listed(items, render, limit = 3) {
  const shown = items.slice(0, limit).map(render);
  if (items.length > limit) shown.push(`*${items.length - limit}* more`);
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] || '';
}
const ids = (values) => [...new Set((Array.isArray(values) ? values : []).filter((value) => snowflake.test(value)))];
const where = (channelIds, unique = ids(channelIds)) => (unique.length ? listed(unique, (id) => `<#${id}>`) : 'the server');
const from = (authorIds, unique = ids(authorIds)) => (unique.length ? ` from ${listed(unique, (id) => `<@${id}>`, 2)}` : '');
const asked = (args) => quote(args?.query || '');
const channelOr = (args, fallback) => (snowflake.test(args?.channelId) ? `<#${args.channelId}>` : fallback);
const inChannel = (args, preposition = 'in') => (snowflake.test(args?.channelId) ? ` ${preposition} <#${args.channelId}>` : '');
const profile = (args, fallback) => `${snowflake.test(args?.userId) ? `<@${args.userId}>’s` : fallback} profile`;
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
  return `over the last ${hours === 1 ? 'hour' : `*${hours}* hours`}`;
}
function activitySubject(args = {}) {
  const keywords = Array.isArray(args.keywords) ? args.keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim()) : [];
  return `${where(args.channelIds)} ${period(args)}${keywords.length ? ` that mentions ${listed(keywords, quote)}` : ''}`;
}
const appName = (tool) => { const app = String(tool || '').split('.')[0]; return appNames[app] || app.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'connected apps'; };
const yourApps = (args) => (args?.app ? `your ${appName(args.app)}` : 'your connected apps');
// App tool names read as verb + object (google_drive.get_spreadsheet_cells -> "reading spreadsheet cells"); only human-readable arguments
// (queries, names, titles, ranges) are shown, never file or message IDs.
const appVerbs = [[/^(search|find)$/, 'searching', 'searched'], [/^(get|read|fetch|retrieve|download|export)$/, 'reading', 'read'], [/^list$/, 'listing', 'listed']];
function appAction(args = {}) {
  const [app, action = ''] = String(args.tool || '').split('.');
  const words = action.toLowerCase().split('_').filter((word, index, all) => word && word !== 'batch' && !(index === all.length - 1 && index > 1 && ['text', 'content'].includes(word)))
    .map((word) => ({ pr: 'PR', prs: 'PRs', pdf: 'PDF', url: 'URL', id: 'ID' })[word] || word);
  const verb = appVerbs.find(([pattern]) => pattern.test(words[0] || ''));
  const object = (verb ? words.slice(1) : words).join(' ');
  const input = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {};
  const pick = (...keys) => keys.map((key) => input[key]).find((value) => typeof value === 'string' && value.trim() && !/^[A-Za-z0-9_-]{20,}$/.test(value.trim()));
  const query = pick('query', 'q', 'search_query', 'search', 'keywords');
  const name = pick('name', 'title', 'file_name', 'filename', 'subject');
  const range = pick('range', 'a1_range', 'sheet_range');
  const where = `your ${appName(app)}`;
  const thing = object ? `${/s$/.test(object) ? '' : /^[aeiou]/.test(object) ? 'an ' : 'a '}${object}` : 'items';
  const detail = `${name ? ` ${quote(name)}` : ''}${range ? ` (${quote(range).slice(1, -1)})` : ''}`;
  if (verb?.[1] === 'searching' || (!verb && query)) return { ing: 'searching', past: 'searched', phrase: `${where}${object && object !== 'emails' && object !== 'files' ? ` ${object}` : ''}${query ? ` for ${quote(query)}` : ''}` };
  if (!verb) return { ing: 'checking', past: 'checked', phrase: `${where}${object ? ` (${object})` : ''}` };
  return { ing: verb[1], past: verb[2], phrase: `${thing}${detail} in ${where}${query ? ` matching ${quote(query)}` : ''}` };
}
const host = (url) => { try { return new URL(url).hostname; } catch { return 'that link'; } };
const filename = (file) => quote(String(file || 'that file').split(/[\\/]/).at(-1));

const activities = {
  pdf_read: { category: 'PDF', start: () => 'I’m reading the PDF attachment.', done: () => 'I’ve read the PDF attachment.', summary: () => ['read', 'the PDF attachment'] },
  discord_read_pdf: { category: 'PDF', start: () => 'I’m opening that PDF attachment.', done: () => 'I’ve opened that PDF attachment.', summary: () => ['read', 'the PDF attachment'] },
  apps_prepare_action: { category: 'approval', start: () => 'I’m preparing an app action for your approval.', done: () => 'I’ve prepared an app action for your approval.', summary: () => ['prepared', 'an app action for approval'] },
  nova_prepare_reminder: { category: 'reminder', start: () => 'I’m preparing your reminder.', done: () => 'I’ve prepared your reminder for approval.', summary: () => ['prepared', 'your reminder'] },
  nova_prepare_alert: { category: 'alert', start: () => 'I’m preparing your conditional alert.', done: () => 'I’ve prepared your alert for approval.', summary: () => ['prepared', 'your conditional alert'] },
  nova_prepare_handoff: { category: 'handoff', start: () => 'I’m preparing the coding task handoff.', done: () => 'I’ve prepared the handoff for approval.', summary: () => ['prepared', 'the coding task handoff'] },
  task_command: { category: 'command', start: () => 'The coding agent is running this command.', done: () => 'The coding agent finished that command.', summary: () => ['ran', 'the coding command'] },
  discord_list_servers: { category: 'servers', start: () => 'I’m checking which servers I can see.', done: (_, count) => (Number.isSafeInteger(count) ? `I’ve found ${plural(count, 'server')} I can see.` : 'I’ve checked the servers I can see.'), summary: () => ['checked', 'which servers I can see'] },
  discord_list_channels: { category: 'channels', start: () => 'I’m looking through the server’s channels.', done: (_, count) => (Number.isSafeInteger(count) ? `I’ve looked through ${plural(count, 'channel')} and threads.` : 'I’ve looked through the server’s channels.'), summary: () => ['looked through', 'the server’s channels'] },
  discord_find_members: { category: 'members', start: (args) => `I’m looking up members matching ${asked(args)}.`, done: (args, count) => `I’ve looked up members matching ${asked(args)}${found(count, 'match')}.`, summary: (args) => ['looked up', `members matching ${asked(args)}`] },
  discord_search_messages: { category: 'search', start: (args) => `I’m currently searching ${searchSubject(args)}.`, done: (args, count) => `I’ve searched ${searchSubject(args)}${found(count)}.`, summary: (args) => ['searched', searchSubject(args)] },
  discord_read_activity: { category: 'search', start: (args) => `I’m reading everything posted in ${activitySubject(args)}.`, done: (args, count) => `I’ve read everything posted in ${activitySubject(args)}${found(count, 'message')}.`, summary: (args) => ['read', `everything posted in ${activitySubject(args)}`] },
  discord_search_batch: { category: 'search', start: (args) => `I’m currently searching ${batchSubject(args)}.`, done: (args, count) => `I’ve searched ${batchSubject(args)}${found(count)}.`, summary: (args) => ['searched', batchSubject(args)] },
  discord_message_context: { category: 'context', start: (args) => `I’m reading the conversation around that message${inChannel(args)}.`, done: (_, count) => (Number.isSafeInteger(count) ? `I’ve read ${plural(count, 'message')} around it.` : 'I’ve read the surrounding conversation.'), summary: (args) => ['read', `the conversation around a message${inChannel(args)}`] },
  discord_browse_messages: { category: 'context', start: (args) => `I’m reading more of ${channelOr(args, 'the conversation')}.`, done: (args, count) => `I’ve read ${Number.isSafeInteger(count) ? plural(count, 'message') : 'more messages'}${inChannel(args, 'from')}.`, summary: (args) => ['read', `more of ${channelOr(args, 'the conversation')}`] },
  discord_user_info: { category: 'profile', start: (args) => `I’m checking ${profile(args, 'that')}.`, done: (args) => `I’ve checked ${profile(args, 'that')}.`, summary: (args) => ['checked', profile(args, 'a')] },
  discord_research_topic: { category: 'topic research', start: (args) => `I’m researching ${asked(args)} across the server’s discussions.`, done: (args) => `I’ve gathered what people said about ${asked(args)}.`, summary: (args) => ['researched', asked(args)] },
  voice_transcribe: { category: 'voice transcription', start: () => 'I’m transcribing your voice note.', done: () => 'I’ve transcribed your voice note.', summary: () => ['transcribed', 'your voice note'] },
  image_read: { category: 'images', start: () => 'I’m looking at the images you sent.', done: () => 'I’ve looked at the images.', summary: () => ['looked at', 'the images you sent'] },
  reply_context: { category: 'reply context', start: () => 'I’m loading the message you replied to.', done: () => 'I’ve loaded the message you replied to.', summary: () => ['loaded', 'the message you replied to'] },
  web_read_link: { category: 'linked page', start: (args) => `I’m reading ${host(args?.url)}.`, done: (args) => `I’ve read ${host(args?.url)}.`, summary: (args) => ['read', host(args?.url)] },
  // Codex reports a search's query only when it finishes, so the started line stays generic until then.
  web_search: { category: 'web search', start: (args) => (args.query ? `I’m searching the web for ${quote(args.query)}.` : args.url ? `I’m opening ${host(args.url)}.` : 'I’m searching the web.'), done: (args) => (args.query ? `I’ve searched the web for ${quote(args.query)}.` : args.url ? `I’ve opened ${host(args.url)}.` : 'I’ve searched the web.'), summary: (args) => (args.query ? ['searched', `the web for ${quote(args.query)}`] : args.url ? ['opened', host(args.url)] : ['searched', 'the web']) },
  apps_list_tools: { category: 'connected apps', start: (args) => `I’m checking what ${yourApps(args)} can do.`, done: (args) => `I’ve checked ${yourApps(args)}.`, summary: (args) => ['checked', yourApps(args)] },
  apps_call_tool: { category: 'connected app', start: (args) => { const action = appAction(args); return `I’m ${action.ing} ${action.phrase}.`; }, done: (args) => { const action = appAction(args); return `I’ve ${action.past} ${action.phrase}.`; }, summary: (args) => { const action = appAction(args); return [action.past, action.phrase]; } },
  project_list: { category: 'projects', start: () => 'I’m checking your approved projects.', done: () => 'I’ve checked your approved projects.', summary: () => ['checked', 'your approved projects'] },
  project_search: { category: 'project search', start: (args) => `I’m searching your project files for ${asked(args)}.`, done: (args, count) => `I’ve searched your project files for ${asked(args)}${found(count, 'match')}.`, summary: (args) => ['searched', `your project files for ${asked(args)}`] },
  project_read_file: { category: 'project file', start: (args) => `I’m reading ${filename(args?.file)} from your project.`, done: (args) => `I’ve read ${filename(args?.file)}.`, summary: (args) => ['read', filename(args?.file)] },
  read_tool_result: { category: 'stored results', start: () => 'I’m going through the rest of those results.', done: () => 'I’ve gone through more of those results.', summary: () => ['went through', 'more of those results'] },
};
// The final edit condenses the log into one sentence, grouping repeated verbs: "I checked your connected apps and your Gmail, and searched …".
function summarize(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.stage !== 'done') continue;
    const [verb, object] = activities[entry.toolName].summary(entry.args, entry.count);
    groups.set(verb, (groups.get(verb) || new Set()).add(object));
  }
  const clauses = [...groups].map(([verb, objects]) => `${verb} ${listed([...objects], (object) => object)}`);
  const failed = entries.filter((entry) => entry.stage === 'failed').length;
  let text = clauses.length ? `I ${clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}` : clauses[0]}.` : '';
  if (failed) text += ` ${failed === 1 ? 'One lookup' : `*${failed}* lookups`} didn’t work.`;
  return text.trim().slice(0, 1900);
}
const failedText = (activity) => (activity.category === 'search' ? 'That search didn’t go through, so I don’t have those results yet.' : 'That lookup didn’t work, so I don’t have those results yet.');

// Presentation has one active mutation and bounded, replaceable pending states. A timed-out
// mutation poisons the queue: a late REST result must never race a newer edit.
export function createDecorationQueue({ signal, timeoutMs = 2000, maxPending = 32, onError = () => {} } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('Invalid decoration queue limits');
  const cancellation = new AbortController();
  const pending = new Map();
  let running;
  let closed = false;
  let poisoned = false;
  let activeCancellation;
  const reportError = (error) => { try { onError(error); } catch {} };

  async function deliver(operation, parentSignal = signal, limit = timeoutMs) {
    const local = new AbortController();
    activeCancellation = local;
    const deliverySignal = AbortSignal.any([local.signal, parentSignal].filter(Boolean));
    let timer;
    try {
      deliverySignal.throwIfAborted();
      await Promise.race([
        Promise.resolve(operation(deliverySignal)),
        new Promise((_, reject) => { timer = setTimeout(() => { poisoned = true; local.abort(); reject(new Error('Nova decoration delivery timed out')); }, limit); }),
      ]);
    } catch (error) { if (!deliverySignal.aborted || poisoned) reportError(error); }
    finally { clearTimeout(timer); if (activeCancellation === local) activeCancellation = undefined; }
  }

  function start() {
    if (!running) {
      running = (async () => {
        while (pending.size && !closed && !poisoned && !signal?.aborted) {
          const [key, next] = pending.entries().next().value;
          pending.delete(key);
          await deliver(next, AbortSignal.any([cancellation.signal, signal].filter(Boolean)));
        }
      })().finally(() => { running = undefined; if (closed || poisoned) pending.clear(); else if (pending.size) start(); });
    }
  }
  function enqueue(key, operation) {
    if (closed || poisoned || signal?.aborted) return Promise.resolve();
    if (!pending.has(key) && pending.size >= maxPending) pending.delete(pending.keys().next().value);
    pending.set(key, operation);
    start();
    return running;
  }

  function close() { closed = true; pending.clear(); cancellation.abort(); activeCancellation?.abort(); }
  async function settle(timeout = 1000) {
    if (!running) return !poisoned;
    let timer;
    const settled = await Promise.race([running.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout); })]);
    clearTimeout(timer);
    if (!settled) { poisoned = true; activeCancellation?.abort(); }
    return settled && !poisoned;
  }
  return { enqueue, close, settle, idle: () => running || Promise.resolve(), final: async (operation, finalSignal, timeout = 1000) => { close(); if (await settle(timeout)) await deliver(operation, finalSignal, timeout); } };
}

export function createProgressReporter({ send, edit, remove, signal, now = Date.now, intervalMs = 1500, maxMessages = 3, deliveryTimeoutMs = 2000, finishTimeoutMs = 1000, onSent = () => {}, onError = () => {} }) {
  const cancellation = new AbortController();
  const startedAt = new Map();
  const delivery = createDecorationQueue({ signal, timeoutMs: deliveryTimeoutMs, maxPending: maxMessages, onError });
  let attempted = 0;
  let closed = false;
  const details = [];

  // Editable mode keeps one message as a running log: a line per tool call, edited from "I'm …" to "I've …" when it finishes.
  const entries = [];
  let receipt;
  let displayed;
  let lastEditAt = -Infinity;
  let dirty = false;
  let flushTimer = null;

  // Without edits every update is a new message, so only the first start of each kind of work (and a slow search's result) is announced.
  const seen = new Set();
  let lastAttemptAt = -Infinity;

  async function attempt(deliverySignal, operation) {
    const sendSignal = AbortSignal.any([cancellation.signal, signal, deliverySignal].filter(Boolean));
    try {
      sendSignal.throwIfAborted();
      await operation(sendSignal);
    } catch (error) { if (!sendSignal.aborted) onError(error); }
  }

  function lineFor(entry, showTrace = true) {
    const activity = activities[entry.toolName];
    if (entry.stage === 'failed') return failedText(activity);
    if (entry.stage === 'done') return activity.done(entry.args, entry.count);
    return activity.start(entry.args) + (showTrace ? `\n\`\`\`\n${commandTrace(entry.toolName, entry.args)}\n\`\`\`` : '');
  }

  function renderLog(showTrace = true) {
    const lines = entries.map((entry) => lineFor(entry, showTrace));
    let first = 0;
    let size = lines.reduce((total, line) => total + line.length + 1, 0);
    while (first < lines.length - 1 && size > 1850) size -= lines[first++].length + 1;
    return `${first ? `…and *${first}* earlier ${first === 1 ? 'step' : 'steps'}\n` : ''}${lines.slice(first).join('\n')}`;
  }

  async function flush(deliverySignal) {
    if (!dirty || closed) return;
    dirty = false;
    const content = renderLog();
    if (content === displayed || (!receipt && attempted >= maxMessages)) return;
    await attempt(deliverySignal, async (sendSignal) => {
      if (receipt) await edit(receipt, content, sendSignal);
      else { attempted += 1; receipt = await send(content, sendSignal, 0); if (!sendSignal.aborted && !closed) onSent(receipt); }
      if (!sendSignal.aborted) { displayed = content; lastEditAt = now(); }
    });
  }

  async function logStep(event, timestamp, resultCount, deliverySignal) {
    const timingKey = event.callId || event.toolName;
    if (event.stage === 'started') { startedAt.set(timingKey, timestamp); if (startedAt.size > 120) startedAt.delete(startedAt.keys().next().value); }
    const elapsedMs = Math.max(0, timestamp - (startedAt.get(timingKey) ?? timestamp));
    if (event.stage !== 'started') startedAt.delete(timingKey);
    details.push({ toolName: event.toolName, stage: event.stage, elapsedMs, ...(resultCount === undefined ? {} : { resultCount }) });
    if (details.length > 50) details.shift();
    if (event.stage === 'started') entries.push({ callId: event.callId || null, toolName: event.toolName, args: event.arguments, stage: 'started' });
    else {
      const entry = entries.find((item) => item.stage === 'started' && item.toolName === event.toolName && (event.callId ? item.callId === event.callId : !item.callId))
        || entries.find((item) => item.stage === 'started' && item.toolName === event.toolName);
      const stage = event.stage === 'completed' ? 'done' : 'failed';
      if (entry) Object.assign(entry, { stage, count: resultCount, args: event.argumentsProvided ? event.arguments : entry.args });
      else entries.push({ callId: event.callId || null, toolName: event.toolName, args: event.arguments, stage, count: resultCount });
    }
    if (entries.length > 60) entries.shift();
    dirty = true;
    const wait = receipt ? intervalMs - (timestamp - lastEditAt) : 0;
    if (wait <= 0) return delivery.enqueue('log', (queueSignal) => flush(AbortSignal.any([queueSignal, deliverySignal].filter(Boolean))));
    // Throttled edits are deferred, never dropped, so the log always catches up with the latest finished step.
    if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; void delivery.enqueue('log', flush); }, wait);
      flushTimer.unref?.();
    }
  }

  async function announce(event, activity, timestamp, resultCount, deliverySignal) {
    const identity = `${event.stage}:${activity.category}`;
    if (seen.has(identity)) return;
    let content = activity.start(event.arguments);
    if (event.stage === 'started') startedAt.set(activity.category, timestamp);
    else if (event.stage === 'completed') {
      if (activity.category !== 'search' || !startedAt.has('search') || timestamp - startedAt.get('search') < 5000) return;
      content = activity.done(event.arguments, resultCount);
    } else content = failedText(activity);

    const firstSearch = event.stage === 'started' && activity.category === 'search';
    if (timestamp - lastAttemptAt < intervalMs && !firstSearch) return;
    seen.add(identity);
    const index = attempted++;
    lastAttemptAt = timestamp;
    return delivery.enqueue(`announcement:${index}`, (queueSignal) => attempt(AbortSignal.any([queueSignal, deliverySignal].filter(Boolean)), async (sendSignal) => onSent(await send(content, sendSignal, index))));
  }

  async function report(rawEvent, deliverySignal) {
    if (closed || signal?.aborted || deliverySignal?.aborted || (!edit && attempted >= maxMessages)) return;
    const activity = Object.hasOwn(activities, rawEvent?.toolName) ? activities[rawEvent.toolName] : null;
    if (!activity || !['started', 'completed', 'failed'].includes(rawEvent.stage)) return;
    // Tool arguments come from the model and may be null or malformed; renderers only ever see a plain object.
    const argumentsProvided = !!rawEvent.arguments && typeof rawEvent.arguments === 'object' && !Array.isArray(rawEvent.arguments);
    const event = { ...rawEvent, arguments: argumentsProvided ? rawEvent.arguments : {}, argumentsProvided };
    const timestamp = now();
    const resultCount = Number.isSafeInteger(event.resultCount) && event.resultCount >= 0 ? event.resultCount : undefined;
    return edit ? logStep(event, timestamp, resultCount, deliverySignal) : announce(event, activity, timestamp, resultCount, deliverySignal);
  }

  function close() { closed = true; cancellation.abort(); delivery.close(); clearTimeout(flushTimer); flushTimer = null; }

  return {
    // Progress is decoration: a rendering or delivery bug is reported, never allowed to reject the tool callback or stall later updates.
    receive: (event, deliverySignal) => {
      // Ingest immediately even while REST is slow; pending rendering contains only the latest log.
      return report(event, deliverySignal).catch((error) => { onError(error); });
    },
    close,
    idle: delivery.idle,
    details: () => details.map((entry) => ({ ...entry })),
    finish: async ({ failed = false, cancelled = false, signal: finishSignal } = {}) => {
      close();
      if (!await delivery.settle(finishTimeoutMs)) return;
      if (!receipt || finishSignal?.aborted) return;
      try {
        // The log stays until the answer is over; then it becomes a one-sentence summary (or keeps the steps with a stop note) and loses its buttons.
        const log = entries.length ? `${renderLog(false)}\n` : '';
        const content = cancelled ? `${log}Stopped this answer.` : failed ? `${log}This answer stopped before it finished. Use /nova status for details or try again.` : summarize(entries) || (remove ? '' : 'Finished checking.');
        await delivery.final(async (deliverySignal) => {
          if (content) await edit(receipt, content, deliverySignal, { components: [] });
          else await remove(receipt, deliverySignal);
        }, finishSignal, finishTimeoutMs);
      } catch (error) { if (!finishSignal?.aborted) onError(error); }
    },
  };
}
