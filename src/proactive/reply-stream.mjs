export function createReplyStream(onMessage) {
  let buffer = '';
  let quoted = false;
  let escaped = false;
  const stack = [];
  let messagesArray = false;
  let messageStart = null;
  let allowed = false;
  let count = 0;

  function push(delta) {
    const start = buffer.length;
    buffer += delta;
    if (buffer.length > 65536) throw new Error('Codex reply exceeded the stream size limit');
    for (let index = start; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === '[' && stack.length === 1) {
        const prefix = JSON.parse(buffer.slice(0, index) + '[]}');
        if (Object.keys(prefix).some((key) => !['shouldReply', 'messages', 'reactions'].includes(key))) throw new Error('Codex emitted an unexpected reply field');
        messagesArray = Object.keys(prefix).at(-1) === 'messages';
        allowed = messagesArray && prefix.shouldReply === true;
      }
      if (character === '{' || character === '[') {
        if (character === '{' && messagesArray && stack.length === 2) messageStart = index;
        stack.push(character);
      } else if (character === '}' || character === ']') {
        if (character === '}' && messagesArray && stack.length === 3 && messageStart !== null) {
          const message = JSON.parse(buffer.slice(messageStart, index + 1));
          messageStart = null;
          count += 1;
          if (count > 5) throw new Error('Codex emitted too many reply bubbles');
          if (allowed) onMessage(message, count - 1);
        }
        if (character === ']' && stack.length === 2) messagesArray = false;
        const expected = character === '}' ? '{' : '[';
        if (stack.pop() !== expected) throw new Error('Codex emitted invalid JSON');
      }
    }
  }

  return { push, text: () => buffer };
}
