import { createCodexResponder } from './codex-responder.mjs';
import { createConversationContext } from './context.mjs';
import { createProactiveEngine } from './engine.mjs';
import { createMemoryStore, memoryPath, parseMemoryCommand } from './memory.mjs';
import { createMemoryCommandHandler } from './memory-commands.mjs';
import { createReplySender } from './reply-sender.mjs';
import { startTypingIndicator } from './typing.mjs';
import { assertOwnerDirectMessageChannel } from './target.mjs';
import { createDiscordReadTools } from './read-tools.mjs';

export async function createChannelRuntime(service, configuration, bot, { warm = true, scheduleReply, onStatus = () => {}, memoryRoot } = {}) {
  const account = service.accountById(configuration.accountId);
  const client = account.client;
  const [guild, channel] = await Promise.all([
    configuration.directMessages ? null : client.getGuild(configuration.guildId), client.getChannel(configuration.channelId),
  ]);
  if (configuration.directMessages) assertOwnerDirectMessageChannel(channel);
  else if (channel.guild_id !== configuration.guildId) throw new Error('Conversation channel does not belong to the requested server');
  const scope = { channelId: channel.id, guildId: guild?.id || null, directMessages: Boolean(configuration.directMessages) };
  const memory = createMemoryStore(memoryPath({ ...configuration, accountId: account.id }, memoryRoot));
  await memory.load();
  const readTools = createDiscordReadTools(service, scope);
  const generateReply = createCodexResponder({ command: configuration.codexCommand, model: configuration.model, reasoningEffort: configuration.reasoningEffort, serviceTier: configuration.serviceTier, scope, readTools });
  if (warm) await generateReply.warmup();
  const conversationContext = createConversationContext(client, { bot, guild, channel, directMessages: configuration.directMessages, gifUrls: configuration.gifUrls });
  const engine = createProactiveEngine({
    ...configuration, botUserId: bot.id, scheduleReply,
    resolveReplyAuthor: async (messageId) => (await client.getMessage(channel.id, messageId)).author?.id,
    getContext: async () => {
      const [context, saved] = await Promise.all([conversationContext(), memory.load()]);
      return { ...context, approvedMemory: saved.text };
    },
    parseCommand: (message) => parseMemoryCommand(message, bot.id),
    handleCommands: createMemoryCommandHandler(memory, bot.id, (messageId) => client.getMessage(channel.id, messageId)),
    startTyping: (signal) => startTypingIndicator((typingSignal) => client.triggerTyping(channel.id, { signal: typingSignal }), { signal }),
    generateReply, sendReplies: createReplySender(service, configuration),
    onStatus,
  });

  function status() {
    return { guildId: guild?.id || null, channelId: channel.id, serverName: guild?.name || null, channelName: channel.name || 'Direct Messages',
      memoryFile: memory.filename, statistics: engine.status(), conversation: generateReply.status() };
  }

  return { receive: engine.receive, status, close: async () => { engine.stop(); await generateReply.close(); } };
}
