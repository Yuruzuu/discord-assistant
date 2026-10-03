import { parseMemoryCommand } from './memory.mjs';

export function createMemoryCommandHandler(store, botUserId, resolveMessage) {
  return async (messages, signal) => {
    const replies = [];
    for (const message of messages) {
      signal?.throwIfAborted();
      const command = parseMemoryCommand(message, botUserId);
      if (!command) throw new Error('Only the owner can issue memory commands');
      let content;
      try {
        if (command.type === 'remember') { await store.remember(command.text); content = 'Saved that in memory.md 📝'; }
        else if (command.type === 'rememberReference') {
          if (!command.messageId) content = 'Tell me “remember this: …”, or reply to a message with “remember this”.';
          else { const source = await resolveMessage(command.messageId); await store.remember(source.content); content = 'Saved that message in memory.md 📝'; }
        }
        else if (command.type === 'consolidate') { await store.consolidate(); content = 'Memory consolidated—duplicates cleaned up, approved facts kept 📝'; }
        else {
          const memory = await store.load();
          content = memory.text === '# Nova memory\n' ? 'No saved memories yet. Tell me “remember this: …” to add one.' : memory.text.slice(0, 1800) + (memory.text.length > 1800 ? '\n…Open memory.md for the rest.' : '');
        }
      } catch {
        content = 'I couldn’t update/read memory.md. Check its size or edit it, then try again.';
      }
      replies.push({ content, gifUrl: null, stickerIds: [] });
    }

    return { shouldReply: true, messages: replies };
  };
}
