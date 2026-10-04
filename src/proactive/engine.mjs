import { acceptsListenerMessage, mentionsBot, directMessageOwnerId } from './target.mjs';
import { createProgressReporter } from './progress.mjs';

export function isQuestion(content) {
  return /\?|^(?:\s|<@!?\d+>)*(?:what|why|how|where|when|who|can|could|would|should|is|are|does|do|help)\b/i.test(content || '');
}

export function createProactiveEngine({ botUserId, guildId, channelId, directMessages = false, mode = 'mentions', startPaused = false, batchWindowMs = 1500, cooldownMs = 5000, maxRepliesPerMinute = 6, resolveReplyAuthor, getContext, generateReply, sendReplies, parseCommand = () => null, handleCommands, scheduleReply = (operation) => operation(), startTyping = () => () => {}, now = Date.now, sleep = wait, onStatus = () => {}, onControl, onBatchComplete = () => {} }) {
  const pending = new Map();
  const queue = [];
  const seen = new Set();
  const replyTimes = [];
  const cancellation = new AbortController();
  const statistics = { received: 0, triggered: 0, replyBatches: 0, sentMessages: 0, streamedMessages: 0, progressMessages: 0, progressErrors: 0, reactions: 0, reactionErrors: 0, lastReactionError: null, lastFirstResponseMs: null, lastFirstActivityMs: null, skipped: 0, errors: 0, queued: 0, lastError: null };
  let busy = false;
  let stopped = false;
  let lastReplyAt = -Infinity;
  let paused = startPaused;
  let discarded = Promise.resolve();
  const idleWaiters = new Set();
  let activeCancellation;
  let lastProgressDetails = [];
  let activeProgress;
  let activeMessageIds = new Set();
  const cleanupTimers = new Set();

  function status() {
    return { ...statistics, queued: queue.length + pending.size, generating: busy, paused, mode };
  }

  function report() { onStatus(status()); }

  function discard(batches) {
    discarded = discarded.catch(() => {}).then(async () => { for (const batch of batches) await onBatchComplete(batch.messages, 'cancelled'); });
    return discarded;
  }

  async function control({ action, value, userId }) {
    if (userId !== directMessageOwnerId) throw new Error('Only the owner can control Nova');
    if (stopped && action !== 'status') throw new Error('This conversation listener has stopped');
    const result = { action };
    if (action === 'status') result.status = { ...status(), conversation: await generateReply.diagnostics?.() };
    else if (action === 'details') result.activities = activeProgress?.details() || lastProgressDetails.map((entry) => ({ ...entry }));
    else if (action === 'stop') { activeCancellation?.abort(); await generateReply.interrupt?.(); }
    else if (action === 'cancel-request') {
      if (activeMessageIds.has(value)) { activeCancellation?.abort(); await generateReply.interrupt?.(); }
      else {
        const removed = [];
        for (const [authorId, batch] of pending) if (batch.messages.some((message) => message.id === value)) { clearTimeout(batch.timer); pending.delete(authorId); removed.push(batch); }
        for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index].messages.some((message) => message.id === value)) removed.push(...queue.splice(index, 1));
        await discard(removed);
      }
    }
    else if (action === 'pause') {
      paused = true;
      const batches = [...pending.values(), ...queue];
      for (const batch of pending.values()) clearTimeout(batch.timer);
      pending.clear();
      queue.length = 0;
      activeCancellation?.abort();
      await generateReply.interrupt?.();
      await sendReplies.clearStatusReactions?.();
      await discard(batches);
    } else if (action === 'resume') paused = false;
    else if (action === 'mode') {
      if (!['mentions', 'questions', 'all'].includes(value)) throw new Error('Unknown conversation mode');
      mode = value;
    }
    else if (action === 'steer') {
      if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('Provide a correction of 1 to 4000 characters');
      if (!activeCancellation || !generateReply.steer) throw new Error('There is no active answer to steer');
      result.result = await generateReply.steer(value);
    } else if (action === 'model' || action === 'effort' || action === 'fast') {
      if (!generateReply.configure) throw new Error('This responder does not support changing settings');
      const configuration = action === 'model' ? { model: value } : action === 'effort' ? { reasoningEffort: value } : { serviceTier: value === true || value === 'on' ? 'priority' : value === false || value === 'off' ? 'default' : null };
      if (action === 'fast' && configuration.serviceTier === null) throw new Error('Fast must be on or off');
      result.result = await generateReply.configure(configuration);
    } else if (action === 'reset' || action === 'compact') {
      if (!generateReply[action]) throw new Error(`This responder does not support ${action}`);
      result.result = await generateReply[action]();
    } else if (onControl) result.result = await onControl({ action, value, userId });
    else throw new Error('Unknown Nova control');
    report();
    return { ...result, paused };
  }

  async function processBatch(batch) {
    const turnCancellation = new AbortController();
    activeCancellation = turnCancellation;
    activeMessageIds = new Set(batch.messages.map((message) => message.id));
    const signal = AbortSignal.any([cancellation.signal, turnCancellation.signal]);
    signal.throwIfAborted();
    const commandBatch = batch.kind === 'command';
    const stopTyping = startTyping(signal);
    let streamed = 0;
    let reacted = 0;
    const trigger = batch.messages.at(-1);
    let replyToMessageId = !directMessages && (batch.messages.length > 1 || trigger.message_reference?.message_id) ? trigger.id : undefined;
    let progressSent = false;
    let failed = false;
    const statusReaction = (stage) => Promise.resolve(sendReplies.statusReaction?.(stage, trigger, cancellation.signal)).catch(() => {});
    await statusReaction('working');
    for (const message of batch.messages.slice(0, -1)) await sendReplies.statusReaction?.(undefined, message, cancellation.signal).catch(() => {});
    const stalledTimer = setTimeout(() => { void statusReaction('stalled'); }, 20000);
    stalledTimer.unref?.();
    const progress = createProgressReporter({
      signal, now,
      ...(sendReplies.progress?.edit ? { edit: sendReplies.progress.edit, remove: sendReplies.progress.remove } : {}),
      send: (content, signal, index) => sendReplies.progress?.(content, batch.messages.at(-1), signal, { index }),
      onSent: (receipt) => {
        if (!receipt?.sentMessages?.length) return;
        if (!progressSent) statistics.lastFirstActivityMs = now() - batch.firstReceivedAt;
        progressSent = true;
        statistics.progressMessages += receipt.sentMessages.length;
        report();
      },
      onError: () => { statistics.progressErrors += 1; report(); },
    });
    activeProgress = progress;
    try {
      let response;
      if (commandBatch) response = await handleCommands(batch.messages, signal);
      else {
        const context = await getContext(batch.messages, signal, { onProgress: progress.receive });
        if (!directMessages && context.recentMessages?.some((message) => BigInt(message.id) > BigInt(trigger.id) && message.authorId !== botUserId)) replyToMessageId = trigger.id;
        signal.throwIfAborted();
        response = await generateReply({ ...context, triggerMessages: batch.messages, mode }, signal, { onProgress: async (event, deliverySignal) => { await statusReaction(event.stage === 'failed' ? 'error' : 'tool'); return progress.receive(event, deliverySignal); }, onMessage: async (message, index, deliverySignal) => {
          if (index !== streamed || streamed >= 5) throw new Error('Reply bubbles arrived out of order');
          signal.throwIfAborted();
          progress.close();
          const receipt = await sendReplies([message], trigger, deliverySignal || signal, { offset: streamed, replyToMessageId });
          if (streamed === 0) statistics.lastFirstResponseMs = now() - batch.firstReceivedAt;
          streamed += 1;
          statistics.sentMessages += receipt.sentMessages.length;
          statistics.streamedMessages += receipt.sentMessages.length;
          lastReplyAt = now();
          report();
        } });
      }
      for (const reaction of response.reactions || []) {
        signal.throwIfAborted();
        try {
          await sendReplies.react(reaction, trigger, signal);
          statistics.reactions += 1;
          reacted += 1;
        } catch (error) {
          if (stopped) return;
          statistics.reactionErrors += 1;
          statistics.lastReactionError = String(error.message).slice(0, 500);
        }
      }
      if (!response.shouldReply || stopped) {
        if (reacted) { statistics.replyBatches += 1; statistics.lastError = null; lastReplyAt = now(); }
        else statistics.skipped += batch.messages.length;
        return;
      }
      signal.throwIfAborted();
      progress.close();
      const remaining = response.messages.slice(streamed);
      const sent = remaining.length ? await sendReplies(remaining, trigger, signal, { offset: streamed, replyToMessageId }) : { sentMessages: [] };
      if (!streamed && sent.sentMessages.length) statistics.lastFirstResponseMs = now() - batch.firstReceivedAt;
      if (response.files?.length) {
        const attached = await sendReplies.files(response.files, trigger, signal, { replyToMessageId: streamed || sent.sentMessages.length ? undefined : replyToMessageId });
        statistics.sentMessages += attached.sentMessages.length;
      }
      statistics.replyBatches += 1;
      statistics.sentMessages += sent.sentMessages.length;
      lastReplyAt = now();
      statistics.lastError = null;
    } catch (error) {
      if (stopped || signal.aborted) return;
      failed = true;
      statistics.errors += 1;
      statistics.lastError = String(error.message).slice(0, 500);
      if (error.sentMessages?.length) {
        statistics.sentMessages += error.sentMessages.length;
        lastReplyAt = now();
      }
    } finally {
      clearTimeout(stalledTimer);
      lastProgressDetails = progress.details();
      await progress.finish({ failed, cancelled: signal.aborted, signal: cancellation.signal });
      stopTyping();
      activeCancellation = null;
      activeMessageIds.clear();
      activeProgress = null;
      await statusReaction(failed ? 'error' : signal.aborted ? undefined : 'done');
      const cleanupTimer = setTimeout(() => { void statusReaction(undefined); cleanupTimers.delete(cleanupTimer); }, 5000);
      cleanupTimer.unref?.();
      cleanupTimers.add(cleanupTimer);
      await onBatchComplete(batch.messages, signal.aborted ? 'cancelled' : failed ? 'failed' : 'sent');
    }
    report();
  }

  async function drain() {
    if (busy || stopped || paused) return;
    busy = true;
    report();
    try {
      while (queue.length && !stopped && !paused) {
        const commandBatch = queue[0].kind === 'command';
        const timestamp = now();
        while (replyTimes[0] <= timestamp - 60000) replyTimes.shift();
        const delay = Math.max(cooldownMs - (timestamp - lastReplyAt), replyTimes.length >= maxRepliesPerMinute ? replyTimes[0] + 60000 - timestamp : 0);
        if (!commandBatch && delay > 0) {
          try { await sleep(delay, undefined, { signal: cancellation.signal }); }
          catch (error) { if (stopped) break; throw error; }
          continue;
        }
        const batch = queue.shift();
        if (!commandBatch) { replyTimes.push(now()); lastReplyAt = now(); }
        if (commandBatch) await processBatch(batch);
        else await scheduleReply(() => processBatch(batch), cancellation.signal);
      }
    } catch (error) {
      if (!stopped) { statistics.errors += 1; statistics.lastError = String(error.message).slice(0, 500); }
    } finally { busy = false; report(); for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); }
  }

  function flush(authorId) {
    const batch = pending.get(authorId);
    if (!batch || stopped) return;
    clearTimeout(batch.timer);
    pending.delete(authorId);
    queue.push(batch);
    report();
    void drain();
  }

  async function receive(message) {
    if (stopped || !acceptsListenerMessage({ guildId, channelId, directMessages }, message)) return false;
    statistics.received += 1;
    if (message.author?.bot || message.webhook_id || !message.author?.id || seen.has(message.id)) { statistics.skipped += 1; report(); return false; }
    seen.add(message.id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);

    const commandText = (message.content || '').replace(/^\s*<@!?\d+>\s*/, '').trim();
    const explicitControl = /^\/?nova\s+(stop|pause|resume|status|details|reset|compact|steer|model|effort|fast)(?:\s*:\s*|\s+)?([\s\S]*)$/i.exec(commandText);
    if (explicitControl) {
      const action = explicitControl[1].toLowerCase();
      if (['stop', 'pause', 'resume', 'status', 'details', 'reset', 'compact'].includes(action) && explicitControl[2].trim()) return false;
      await control({ action, value: explicitControl[2].trim(), userId: message.author.id });
      return true;
    }
    if (paused) { statistics.skipped += 1; report(); return false; }

    const authorId = message.author.id;
    let existing = pending.get(authorId);
    const mentioned = mentionsBot(message, botUserId);
    let repliesToBot = message.referenced_message?.author?.id === botUserId || message.referenceAuthorId === botUserId;
    if (!directMessages && !existing && !mentioned && !repliesToBot && message.message_reference?.message_id) {
      try { repliesToBot = await resolveReplyAuthor(message.message_reference.message_id) === botUserId; }
      catch { repliesToBot = false; }
    }
    if (stopped) return false;
    existing = pending.get(authorId);
    if (!directMessages && !existing && !mentioned && !repliesToBot && mode !== 'all' && !(mode === 'questions' && isQuestion(message.content))) {
      statistics.skipped += 1; report(); return false;
    }
    const kind = message.hostProvenance ? 'task' : parseCommand(message) ? 'command' : 'chat';
    if (existing && existing.kind !== kind) { flush(authorId); existing = null; }
    if (!existing && queue.length + pending.size >= 20) { statistics.skipped += 1; report(); return false; }

    const batch = existing || { messages: [], firstReceivedAt: now(), timer: null, kind };
    batch.messages.push(message);
    statistics.triggered += 1;
    void Promise.resolve(sendReplies.statusReaction?.('queued', message, cancellation.signal)).catch(() => {});
    clearTimeout(batch.timer);
    pending.set(authorId, batch);
    if (kind !== 'chat' || batch.messages.length >= 5 || now() - batch.firstReceivedAt >= 5000) flush(authorId);
    else batch.timer = setTimeout(flush, batchWindowMs, authorId);
    report();

    return true;
  }

  function stop() {
    stopped = true;
    cancellation.abort();
    const batches = [...pending.values(), ...queue];
    for (const batch of pending.values()) clearTimeout(batch.timer);
    pending.clear();
    queue.length = 0;
    for (const timer of cleanupTimers) clearTimeout(timer);
    cleanupTimers.clear();
    void Promise.resolve(sendReplies.clearStatusReactions?.()).catch(() => {});
    void discard(batches).catch(() => {});
    report();
  }

  async function idle() { if (busy) await new Promise((resolve) => idleWaiters.add(resolve)); await discarded; }

  return { receive, stop, status, control, idle };
}
import { setTimeout as wait } from 'node:timers/promises';
