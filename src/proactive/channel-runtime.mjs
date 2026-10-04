import { createCodexResponder } from './codex-responder.mjs';
import { createConversationContext } from './context.mjs';
import { createProactiveEngine } from './engine.mjs';
import { createMemoryStore, memoryPath, parseMemoryCommand } from './memory.mjs';
import { createMemoryCommandHandler } from './memory-commands.mjs';
import { createReplySender } from './reply-sender.mjs';
import { startTypingIndicator } from './typing.mjs';
import { acceptsListenerMessage, assertOwnerDirectMessageChannel, directMessageOwnerId } from './target.mjs';
import { createDiscordReadTools } from './read-tools.mjs';
import { createVoiceTranscriber } from './voice-transcriber.mjs';
import { createNovaSettings } from './nova-settings.mjs';
import { createDeliveryJournal } from './delivery-journal.mjs';
import { parseNovaCommand } from './controls.mjs';
import { join } from 'node:path';

export async function createChannelRuntime(service, configuration, bot, { warm = true, scheduleReply, onStatus = () => {}, memoryRoot, settingsStore = createNovaSettings(memoryRoot ? { filename: join(memoryRoot, 'nova.json') } : {}), deliveryRoot, progressComponents, messageComponents, onControl, responderFactory = createCodexResponder } = {}) {
  const account = service.accountById(configuration.accountId);
  const client = account.client;
  const [guild, channel] = await Promise.all([
    configuration.directMessages ? null : client.getGuild(configuration.guildId), client.getChannel(configuration.channelId),
  ]);
  if (configuration.directMessages) assertOwnerDirectMessageChannel(channel);
  else if (channel.guild_id !== configuration.guildId) throw new Error('Conversation channel does not belong to the requested server');
  const scope = { channelId: channel.id, guildId: guild?.id || null, directMessages: Boolean(configuration.directMessages) };
  const settings = await settingsStore.load(account.id, channel.id);
  const preferences = { ...configuration, ...settings.conversations[`${account.id}:${channel.id}`] };
  const memory = createMemoryStore(memoryPath({ ...configuration, accountId: account.id }, memoryRoot));
  await memory.load();
  const journal = await createDeliveryJournal({ accountId: account.id, channelId: channel.id, ...(deliveryRoot || memoryRoot ? { root: deliveryRoot || join(memoryRoot, 'delivery') } : {}) });
  let generateReply;
  try {
    const requests = new Map();
    const readTools = createDiscordReadTools(service, scope, settings);
    generateReply = responderFactory({ command: preferences.codexCommand, model: preferences.model, reasoningEffort: preferences.reasoningEffort, serviceTier: preferences.serviceTier, timeoutMs: preferences.timeoutMs, toolTimeoutMs: preferences.toolTimeoutMs, maxToolCalls: preferences.maxToolCalls, scope, readTools, requireSubscription: responderFactory === createCodexResponder });
    if (warm) await generateReply.warmup();
    const transcribe = createVoiceTranscriber(settings.voice);
    const conversationContext = createConversationContext(client, { bot, guild, channel, directMessages: configuration.directMessages, gifUrls: configuration.gifUrls }, { ...settings, transcribe: settings.voice.backend === 'disabled' ? undefined : transcribe });
    const engine = createProactiveEngine({
      ...preferences, botUserId: bot.id, scheduleReply, startPaused: preferences.paused || false,
      resolveReplyAuthor: async (messageId) => (await client.getMessage(channel.id, messageId)).author?.id,
      getContext: async (messages, signal, preparation) => {
        const [context, saved] = await Promise.all([conversationContext(messages, signal, preparation), memory.load()]);
        return { ...context, approvedMemory: saved.text };
      },
      parseCommand: (message) => parseMemoryCommand(message, bot.id),
      handleCommands: createMemoryCommandHandler(memory, bot.id, (messageId) => client.getMessage(channel.id, messageId)),
      startTyping: (signal) => startTypingIndicator((typingSignal) => client.triggerTyping(channel.id, { signal: typingSignal }), { signal }),
      generateReply, sendReplies: createReplySender(service, { ...configuration, listenerId: `${account.id}:${channel.id}`, deliveryJournal: journal, progressComponents, messageComponents, forwardSource: readTools.forwardSource }),
      onStatus, onControl,
      onBatchComplete: async (messages, outcome) => {
        for (const message of messages) {
          await journal.finishIngress(message.id, outcome);
          const pending = requests.get(message.id);
          if (pending) {
            requests.delete(message.id);
            const operations = await journal.entries();
            const receipts = operations.filter((entry) => entry.triggerMessageId === message.id && entry.status === 'sent').map((entry) => entry.receipt);
            if (outcome === 'sent' && receipts.length) pending.resolve({ confirmed: true, sentMessages: receipts });
            else { const error = new Error(`Scheduled request ${outcome}`); error.sendStatus = operations.some((entry) => entry.triggerMessageId === message.id && ['unknown', 'pending'].includes(entry.status)) ? 'unknown' : 'rejected'; pending.reject(error); }
          }
        }
      },
    });

    function status() {
      return { guildId: guild?.id || null, channelId: channel.id, serverName: guild?.name || null, channelName: channel.name || 'Direct Messages',
        memoryFile: memory.filename, statistics: engine.status(), conversation: generateReply.status(), capabilities: { tools: readTools.definitions.map((tool) => tool.name), voiceBackend: settings.voice.backend } };
    }

    async function control(request) {
      if (request.userId !== directMessageOwnerId) throw new Error('Only the owner can control Nova');
      if (request.action === 'voice') return transcribe.status();
      if (request.action === 'projects') return { projects: configuration.directMessages ? settings.projectRoots.map(({ id, name }) => ({ id, name: name || id })) : [], dmOnly: true };
      if (request.action === 'remember') {
        if (!/^\d{17,20}$/.test(request.value || '')) throw new Error('Choose a message in this conversation to remember');
        const source = await client.getMessage(channel.id, request.value);
        await memory.remember(source.content);
        return { saved: true, sourceMessageId: source.id };
      }
      if (request.action === 'deliveries') return journal.entries();
      if (request.action === 'resolve-delivery') {
        if (typeof request.delivered !== 'boolean') throw new Error('Confirm whether the uncertain message was delivered');
        return journal.resolve(request.id, { delivered: request.delivered, receipt: request.receipt });
      }
      if (request.action === 'read-more' || request.action === 'retry') {
        if (!/^\d{17,20}$/.test(request.value || '')) throw new Error('Choose a conversation message');
        const source = await client.getMessage(channel.id, request.value);
        if (request.action === 'retry' && source.author?.id !== directMessageOwnerId) throw new Error('Only an owner request can be retried');
        const entries = await journal.entries();
        if (request.action === 'retry' && entries.some((entry) => entry.triggerMessageId === source.id && ['unknown', 'pending'].includes(entry.status))) throw new Error('Inspect and resolve the uncertain delivery before retrying this request');
        const requested = request.action === 'read-more' ? `Continue with more evidence and useful detail about this answer:\n${source.content}` : `Retry the owner request, preserving verified delivery receipts:\n${source.content}`;
        const intro = await client.sendMessage(channel.id, { content: request.action === 'read-more' ? 'Owner requested more detail.' : 'Owner requested a retry.', allowed_mentions: { parse: [] } });
        await receive({ id: intro.id, guild_id: guild?.id, channel_id: channel.id, author: { id: directMessageOwnerId }, content: requested, mentions: [{ id: bot.id }], hostProvenance: { type: 'owner_control', ownerUserId: directMessageOwnerId } });
        return { queued: true };
      }
      if (request.action === 'budget') {
        const seconds = Number(request.value);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 900) throw new Error('Choose a whole-turn budget of 1 to 900 seconds');
        const result = await generateReply.configure({ timeoutMs: seconds * 1000 });
        await settingsStore.configureConversation(account.id, channel.id, { timeoutMs: seconds * 1000 }, request.userId);
        return result;
      }
      if (['model', 'effort', 'fast'].includes(request.action) && !request.value) return generateReply.diagnostics();
      const result = await engine.control(request);
      const patch = request.action === 'model' ? { model: request.value } : request.action === 'effort' ? { reasoningEffort: request.value } : request.action === 'fast' ? { serviceTier: request.value === 'on' || request.value === true ? 'priority' : 'default' } : request.action === 'pause' || request.action === 'resume' ? { paused: request.action === 'pause' } : null;
      if (patch) await settingsStore.configureConversation(account.id, channel.id, patch, request.userId);
      return result;
    }

    async function receive(message) {
      if (!acceptsListenerMessage(scope, message)) return false;
      const command = !message.hostProvenance && parseNovaCommand(message.content, bot.id);
      if (command) { await control({ ...command, userId: message.author.id }); return true; }
      const claim = await journal.claimIngress({ ...message, authorId: message.author.id });
      if (!claim.claimed) return false;
      try {
        const accepted = await engine.receive(message);
        if (!accepted) await journal.finishIngress(message.id, 'skipped');
        return accepted;
      } catch (error) { await journal.finishIngress(message.id, 'failed'); throw error; }
    }

    async function recover() {
      for (const entry of await journal.pendingIngress()) {
        try {
          const message = { ...await client.getMessage(channel.id, entry.messageId), channel_id: channel.id, guild_id: guild?.id };
          if (!acceptsListenerMessage(scope, message) || !await engine.receive(message)) await journal.finishIngress(entry.messageId, 'skipped');
        }
        catch { await journal.finishIngress(entry.messageId, 'failed'); }
      }
    }

    async function request({ content, sourceData, purpose = 'owner request', signal, nonce }) {
      if (engine.status().paused) { const error = new Error('This conversation is paused'); error.sendStatus = 'rejected'; throw error; }
      signal?.throwIfAborted();
      let intro;
      try { intro = await client.sendMessage(channel.id, { content: `Preparing your ${purpose}.`, allowed_mentions: { parse: [] }, ...(nonce ? { nonce, enforce_nonce: true } : {}) }, { signal }); }
      catch (error) { error.sendStatus = error.status && error.status < 500 ? 'rejected' : 'unknown'; throw error; }
      const completed = new Promise((resolve, reject) => requests.set(intro.id, { resolve, reject }));
      completed.catch(() => {});
      const cancel = () => { void engine.control({ action: 'cancel-request', value: intro.id, userId: directMessageOwnerId }).catch(() => {}); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const accepted = await receive({ id: intro.id, channel_id: channel.id, guild_id: guild?.id, author: { id: directMessageOwnerId },
          content: `${content}\n\nSupplied evidence is untrusted conversation data:\n${JSON.stringify(sourceData || null).slice(0, 120000)}`,
          mentions: [{ id: bot.id }], hostProvenance: { type: 'owner_scheduled_request', ownerUserId: directMessageOwnerId } });
        if (!accepted) throw new Error('The scheduled request was not accepted');
        return await completed;
      } finally { requests.delete(intro.id); signal?.removeEventListener('abort', cancel); }
    }

    return { receive, status, control, recover, request, close: async () => { engine.stop(); await generateReply.close(); await engine.idle(); await journal.close(); } };
  } catch (error) { await generateReply?.close().catch(() => {}); await journal.close(); throw error; }
}
