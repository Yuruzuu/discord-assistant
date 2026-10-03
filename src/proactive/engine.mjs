import { acceptsListenerMessage } from './target.mjs';

export function isQuestion(content) {
  return /\?|^(?:\s|<@!?\d+>)*(?:what|why|how|where|when|who|can|could|would|should|is|are|does|do|help)\b/i.test(content || '');
}

export function createProactiveEngine({ botUserId, guildId, channelId, directMessages = false, mode = 'mentions', batchWindowMs = 1500, cooldownMs = 5000, maxRepliesPerMinute = 6, resolveReplyAuthor, getContext, generateReply, sendReplies, parseCommand = () => null, handleCommands, startTyping = () => () => {}, now = Date.now, sleep = wait, onStatus = () => {} }) {
  const pending = new Map();
  const queue = [];
  const seen = new Set();
  const replyTimes = [];
  const cancellation = new AbortController();
  const statistics = { received: 0, triggered: 0, replyBatches: 0, sentMessages: 0, streamedMessages: 0, lastFirstResponseMs: null, skipped: 0, errors: 0, queued: 0, lastError: null };
  let busy = false;
  let stopped = false;
  let lastReplyAt = -Infinity;

  function status() {
    return { ...statistics, queued: queue.length + pending.size, generating: busy };
  }

  function report() { onStatus(status()); }

  async function drain() {
    if (busy || stopped) return;
    busy = true;
    report();
    try {
      while (queue.length && !stopped) {
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
        const stopTyping = startTyping(cancellation.signal);
        let streamed = 0;
        try {
          let response;
          if (commandBatch) response = await handleCommands(batch.messages, cancellation.signal);
          else {
            const context = await getContext(batch.messages, cancellation.signal);
            cancellation.signal.throwIfAborted();
            response = await generateReply({ ...context, triggerMessages: batch.messages, mode }, cancellation.signal, { onMessage: async (message, index, deliverySignal) => {
              if (index !== streamed || streamed >= 5) throw new Error('Reply bubbles arrived out of order');
              cancellation.signal.throwIfAborted();
              const receipt = await sendReplies([message], batch.messages.at(-1), deliverySignal || cancellation.signal, { offset: streamed });
              if (streamed === 0) statistics.lastFirstResponseMs = now() - batch.firstReceivedAt;
              streamed += 1;
              statistics.sentMessages += receipt.sentMessages.length;
              statistics.streamedMessages += receipt.sentMessages.length;
              lastReplyAt = now();
              report();
            } });
          }
          if (!response.shouldReply || stopped) { statistics.skipped += batch.messages.length; continue; }
          cancellation.signal.throwIfAborted();
          const remaining = response.messages.slice(streamed);
          const sent = remaining.length ? await sendReplies(remaining, batch.messages.at(-1), cancellation.signal, { offset: streamed }) : { sentMessages: [] };
          if (!streamed && sent.sentMessages.length) statistics.lastFirstResponseMs = now() - batch.firstReceivedAt;
          statistics.replyBatches += 1;
          statistics.sentMessages += sent.sentMessages.length;
          lastReplyAt = now();
          statistics.lastError = null;
        } catch (error) {
          if (stopped) break;
          statistics.errors += 1;
          statistics.lastError = String(error.message).slice(0, 500);
          if (error.sentMessages?.length) {
            statistics.sentMessages += error.sentMessages.length;
            lastReplyAt = now();
          }
        } finally { stopTyping(); }
        report();
      }
    } catch (error) {
      if (!stopped) { statistics.errors += 1; statistics.lastError = String(error.message).slice(0, 500); }
    } finally { busy = false; report(); }
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

    const authorId = message.author.id;
    let existing = pending.get(authorId);
    const mentioned = (message.mentions || []).some((user) => user.id === botUserId) || new RegExp(`<@!?${botUserId}>`).test(message.content || '');
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
    const kind = parseCommand(message) ? 'command' : 'chat';
    if (existing && existing.kind !== kind) { flush(authorId); existing = null; }
    if (!existing && queue.length + pending.size >= 20) { statistics.skipped += 1; report(); return false; }

    const batch = existing || { messages: [], firstReceivedAt: now(), timer: null, kind };
    batch.messages.push(message);
    statistics.triggered += 1;
    clearTimeout(batch.timer);
    pending.set(authorId, batch);
    if (kind === 'command' || batch.messages.length >= 5 || now() - batch.firstReceivedAt >= 5000) flush(authorId);
    else batch.timer = setTimeout(flush, batchWindowMs, authorId);
    report();

    return true;
  }

  function stop() {
    stopped = true;
    cancellation.abort();
    for (const batch of pending.values()) clearTimeout(batch.timer);
    pending.clear();
    queue.length = 0;
    report();
  }

  return { receive, stop, status };
}
import { setTimeout as wait } from 'node:timers/promises';
