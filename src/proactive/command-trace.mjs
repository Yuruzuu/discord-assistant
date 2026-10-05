const hidden = /(?:authorization|password|secret|token|api.?key|cookie|credential)/i;
const visibleFields = new Set(['query', 'queries', 'guildId', 'channelId', 'messageId', 'attachmentId', 'authorIds', 'channelIds', 'limit', 'limitPerSearch', 'count', 'day', 'hours', 'startLine', 'projectId', 'file', 'tool', 'access', 'taskId', 'harness', 'model', 'url']);

export function sanitizeCommand(command) {
  return String(command || '').replace(/```/g, 'ˋˋˋ').replace(/\u0000/g, '')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/((?:--)?(?:password|token|secret|api[_-]?key|authorization|cookie)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|secret|signature|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(?:mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{6}\.[\w-]{25,}|sk-[\w-]{16,})/g, '[redacted]').slice(0, 700);
}

export function commandTrace(toolName, args = {}) {
  if (toolName === 'task_command') return sanitizeCommand(args.command);
  const preview = {};
  for (const [key, value] of Object.entries(args)) {
    if (!visibleFields.has(key) || hidden.test(key) || value === undefined) continue;
    if (key === 'file') preview[key] = String(value).split(/[\\/]/).at(-1);
    else if (key === 'url') { try { preview[key] = new URL(value).hostname; } catch { continue; } }
    else if (Array.isArray(value)) preview[key] = value.slice(0, 5).map((item) => typeof item === 'string' ? sanitizeCommand(item).slice(0, 80) : '[object]');
    else if (['string', 'number', 'boolean'].includes(typeof value)) preview[key] = typeof value === 'string' ? sanitizeCommand(value).replace(/[\r\n`*~|<>@#]/g, ' ').slice(0, 120) : value;
  }
  return `${String(toolName).replace(/[^A-Za-z0-9_.-]/g, '')}(${JSON.stringify(preview)})`.slice(0, 700);
}
