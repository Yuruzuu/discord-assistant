import { isDeepStrictEqual } from 'node:util';

export function unicodePrefix(text, length) {
  let end = Math.min(text.length, length);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] || '')) end -= 1;
  return text.slice(0, end);
}

// Keep the lossless result behind its conversation-local handle; this is only the model's preview.
export function projectToolResult(source, { budget, handle }) {
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const originalBytes = bytes(source);
  if (originalBytes <= budget) return JSON.stringify(source);
  let maxText = Math.min(8192, Math.floor(budget / 4));
  let maxItems = 64;
  for (;;) {
    const omissions = [];
    const record = (entry) => omissions.push(entry);
    function project(value, path = '') {
      if (['toolImageSources', 'omittedImages', 'navigation', 'continuation'].includes(path.split('.').at(-1))) return value;
      if (typeof value === 'string' && value.length > maxText) {
        const preview = unicodePrefix(value, maxText);
        record({ path, kind: 'text', returnedCharacters: preview.length, availableCharacters: value.length });
        return preview;
      }
      if (Array.isArray(value)) {
        const selected = value.slice(0, maxItems);
        if (selected.length < value.length) record({ path, kind: 'array', returned: selected.length, available: value.length });
        return selected.map((item, index) => project(item, `${path}[${index}]`));
      }
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, project(item, path ? `${path}.${field}` : field)]));
      return value;
    }
    const reduced = { ...source };
    if (source.structuredContent !== undefined && typeof source.text === 'string') {
      try {
        if (isDeepStrictEqual(JSON.parse(source.text), source.structuredContent)) {
          delete reduced.text;
          record({ path: 'text', kind: 'duplicate', source: 'structuredContent' });
        }
      } catch {}
    }
    const projected = project(reduced);
    const result = {
      ...projected, resultHandle: handle,
      partial: { originalBytes, omissions: omissions.slice(0, 128), omittedDetails: Math.max(0, omissions.length - 128), nextStep: 'Read the lossless source with read_tool_result using resultHandle and nextOffset. Retain source message IDs, URLs and page numbers when citing evidence.' },
    };
    if (bytes(result) <= budget) return JSON.stringify(result);
    if (maxText > 128 || maxItems > 1) {
      maxText = Math.max(128, Math.floor(maxText / 2));
      maxItems = Math.max(1, Math.floor(maxItems / 2));
      continue;
    }
    const sourceText = JSON.stringify(source);
    let previewLength = Math.floor(budget / 6);
    const attribution = Object.fromEntries(['messageId', 'channelId', 'attachmentId', 'url', 'toolImageSources', 'omittedImages', 'privateOwnerData'].filter((field) => Object.hasOwn(source, field)).map((field) => [field, source[field]]));
    const preview = () => JSON.stringify({ ...attribution, resultHandle: handle, partial: { originalBytes, availableCharacters: sourceText.length, nextStep: 'Use read_tool_result for the lossless source, following nextOffset.' }, preview: unicodePrefix(sourceText, previewLength), untrustedContent: true });
    if (Buffer.byteLength(preview()) > budget && Buffer.byteLength(JSON.stringify(attribution)) > budget / 2) throw new Error('Tool source attribution exceeds the model budget; use a narrower query.');
    while (Buffer.byteLength(preview()) > budget) previewLength = Math.floor(previewLength / 2);
    return preview();
  }
}
