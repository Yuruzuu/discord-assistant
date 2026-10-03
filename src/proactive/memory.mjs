import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { directMessageOwnerId } from './target.mjs';
import { proactiveRoot } from './state.mjs';

const maximumBytes = 16384;

export function memoryPath({ accountId, channelId, directMessages }, root = join(dirname(proactiveRoot()), 'memory')) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !/^\d{17,20}$/.test(channelId)) throw new Error('Invalid memory conversation');
  return join(root, `${accountId}-${directMessages ? `dm-${directMessageOwnerId}` : channelId}`, 'memory.md');
}

export function parseMemoryCommand(message, botUserId) {
  if (message.author?.id !== directMessageOwnerId) return null;
  const text = (message.content || '').trim().replace(new RegExp(`^(?:<@!?${botUserId}>\\s*)+`), '').trim();
  const remember = text.match(/^(?:remember this(?:\s*[:,]\s*|\s+)|remember\s*:\s*|\/remember(?:\s*:\s*|\s+))([\s\S]+)$/i);
  if (remember) return { type: 'remember', text: remember[1].trim() };
  if (/^remember this[.!]?$/i.test(text)) return { type: 'rememberReference', messageId: message.message_reference?.message_id || null };
  if (/^(?:consolidate memory|\/consolidate-memory)[.!]?$/i.test(text)) return { type: 'consolidate' };
  if (/^(?:show memory|\/memory)[.!]?$/i.test(text)) return { type: 'show' };
  return null;
}

export function createMemoryStore(filename) {
  let writes = Promise.resolve();

  async function load() {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    let text;
    try { text = await readFile(filename, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await writeFile(filename, '# Nova memory\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      text = await readFile(filename, 'utf8');
    }
    if (Buffer.byteLength(text) > maximumBytes) throw new Error('memory.md exceeds 16 KiB; edit it before continuing');
    return { text, revision: createHash('sha256').update(text).digest('hex') };
  }

  function update(transform) {
    const operation = writes.catch(() => {}).then(async () => {
      const previous = await load();
      const text = transform(previous.text);
      if (Buffer.byteLength(text) > maximumBytes) throw new Error('Memory is full; consolidate or edit memory.md');
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600 });
        if (await readFile(filename, 'utf8') !== previous.text) throw new Error('Memory changed during saving; retry your command');
        await rename(temporary, filename);
      }
      finally { await rm(temporary, { force: true }); }
      return { text, revision: createHash('sha256').update(text).digest('hex') };
    });
    writes = operation;
    return operation;
  }

  function remember(text) {
    if (!text?.trim() || text.length > 2000) return Promise.reject(new Error('Provide a memory note of 1 to 2000 characters'));
    return update((previous) => `${previous.trimEnd()}\n\n- ${text.trim().replace(/\r\n/g, '\n').replace(/\n/g, '\n  ')}\n`);
  }

  function consolidate() {
    return update((previous) => {
      const entries = [];
      let current = '';
      function append() { if (current.trim()) entries.push(current.trim()); current = ''; }
      for (const line of previous.split(/\r?\n/)) {
        if (line === '# Nova memory') { append(); continue; }
        if (line.startsWith('- ')) { append(); current = line.slice(2); }
        else if (line.trim()) current += `${current ? '\n' : ''}${line.trim()}`;
        else append();
      }
      append();
      const seen = new Set();
      const unique = entries.filter((entry) => {
        const key = entry;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      return '# Nova memory\n' + (unique.length ? `\n${unique.map((entry) => `- ${entry.replace(/\n/g, '\n  ')}`).join('\n\n')}\n` : '');
    });
  }

  return { filename, load, remember, consolidate };
}
