const attachmentExtensions = /\.(?:txt|md|json|csv|lua|luau|js|mjs|ts|html|css|xml|yaml|yml|log)$/i;

export function validateGeneratedFiles(files = []) {
  if (!Array.isArray(files) || files.length > 3) throw new Error('Provide at most 3 generated text files');
  let total = 0;
  const names = new Set();
  return files.map((file) => {
    if (!file || typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/.test(file.name) || !attachmentExtensions.test(file.name) || file.name.includes('..') || names.has(file.name)) throw new Error('Invalid generated file name');
    if (typeof file.content !== 'string') throw new Error('Generated file content must be text');
    const size = Buffer.byteLength(file.content);
    total += size;
    if (!size || size > 128 * 1024 || total > 256 * 1024) throw new Error('Generated files exceed the text attachment limit');
    names.add(file.name);
    return { name: file.name, content: file.content };
  });
}

export function splitDiscordText(content, limit = 2000) {
  if (typeof content !== 'string' || content.length > 16000 || limit < 128) throw new Error('Invalid Discord text chunk input');
  if (content.length <= limit) return [content];
  const chunks = [];
  let remaining = content;
  let fence = null;
  while (remaining) {
    const prefix = fence === null ? '' : `\`\`\`${fence}\n`;
    const allowance = limit - prefix.length - 5;
    let length = Math.min(allowance, remaining.length);
    if (length < remaining.length) {
      const boundary = remaining.lastIndexOf('\n', length);
      const space = remaining.lastIndexOf(' ', length);
      if (boundary > allowance / 2) length = boundary + 1;
      else if (space > allowance / 2) length = space + 1;
      if (/^[\uDC00-\uDFFF]$/.test(remaining[length])) length -= 1;
      const lastFence = remaining.lastIndexOf('```', length);
      if (lastFence >= 0 && lastFence < length && lastFence + 3 > length) length = lastFence;
    }
    const piece = remaining.slice(0, length);
    for (const match of piece.matchAll(/(?:^|\n)```([^\n]*)/g)) fence = fence === null ? match[1].trim().slice(0, 80) : null;
    const suffix = fence !== null ? '\n```' : '';
    chunks.push(prefix + piece + suffix);
    remaining = remaining.slice(length);
    if (chunks.length > 12) throw new Error('Discord reply requires too many text chunks');
  }
  return chunks;
}
