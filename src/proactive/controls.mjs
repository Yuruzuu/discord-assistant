import { randomBytes } from 'node:crypto';
import { directMessageOwnerId } from './target.mjs';

const simpleActions = ['status', 'stop', 'pause', 'resume', 'details', 'reset', 'compact', 'voice', 'projects', 'deliveries'];

export function parseNovaCommand(content, botUserId) {
  const text = String(content || '').replace(new RegExp(`^\\s*<@!?${botUserId}>\\s*`), '').trim();
  const match = /^\/?nova\s+([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  const action = match[1].toLowerCase();
  const value = (match[2] || '').trim();
  if (simpleActions.includes(action)) return value ? null : { action };
  if (['model', 'effort', 'fast', 'steer', 'research', 'budget'].includes(action)) return { action, value };
  if (action === 'jobs') {
    const [operation = 'list', id] = value.split(/\s+/);
    if (!['list', 'stop', 'status'].includes(operation)) return null;
    return { action: 'jobs', operation, id };
  }
  if (action === 'digest') {
    const [operation = 'list', ...rest] = value.split(/\s+/);
    if (['list', 'remove', 'run', 'status'].includes(operation)) return { action: 'digest', operation, id: rest[0] };
    if (operation === 'add') {
      try { const configuration = JSON.parse(rest.join(' ')); return { action: 'digest', operation, configuration }; }
      catch { return { action: 'help', value: 'Use nova digest add {"guildId":"...","query":"...","intervalMinutes":60}' }; }
    }
  }
  if (action === 'resolve-delivery') {
    try { return { action, ...JSON.parse(value) }; } catch { return { action: 'help', value: 'Use nova resolve-delivery {"id":"operation ID","delivered":false}' }; }
  }
  return null;
}

export function novaSlashCommand() {
  const textOption = (name, description, required = false) => ({ type: 3, name, description, required });
  const subcommand = (name, description, options = []) => ({ type: 1, name, description, options });
  return { name: 'nova', description: 'Owner-only Nova controls', dm_permission: true, options: [
    ...simpleActions.map((action) => subcommand(action, `${action} Nova in this conversation`)),
    ...['model', 'effort', 'fast', 'steer', 'budget'].map((action) => subcommand(action, `${action} setting or correction`, [textOption('value', 'Requested value; omit to inspect', action === 'steer')])),
    subcommand('research', 'Start a research job in a new public thread', [textOption('request', 'Research request', true), textOption('guild', 'Server ID for requests from DMs'), textOption('channel', 'Parent channel ID for requests from DMs')]),
    subcommand('jobs', 'Inspect or stop research jobs', [textOption('operation', 'list, status, or stop'), textOption('id', 'Job ID')]),
    subcommand('digest', 'Opt in to discussion digests delivered in your DMs', [textOption('operation', 'list, add, remove, run, or status'), textOption('configuration', 'JSON configuration for add'), textOption('id', 'Digest ID')]),
  ] };
}

export function readNovaInteraction(interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'nova') return null;
  const action = interaction.options.getSubcommand();
  const string = (name) => interaction.options.getString(name) || undefined;
  const request = { action, value: string('value'), userId: interaction.user.id, guildId: interaction.guildId || undefined, channelId: interaction.channelId };
  if (action === 'research') Object.assign(request, { value: string('request'), guildId: string('guild') || request.guildId, channelId: string('channel') || request.channelId });
  if (action === 'jobs' || action === 'digest') Object.assign(request, { operation: string('operation') || 'list', id: string('id') });
  if (action === 'digest' && request.operation === 'add') {
    try { request.configuration = JSON.parse(string('configuration') || '{}'); }
    catch { request.action = 'help'; request.value = 'Digest configuration must be valid JSON'; }
  }
  return request;
}

export function createControlButtons({ now = Date.now, ttlMs = 30 * 60000, maximum = 500 } = {}) {
  const tokens = new Map();
  function create(scope, actions = ['details', 'stop']) {
    for (const [key, value] of tokens) if (value.expiresAt <= now()) tokens.delete(key);
    const labels = { details: 'Details', stop: 'Stop answer', remember: 'Remember message', 'read-more': 'Read more', retry: 'Retry request' };
    const buttons = actions.slice(0, 5).map((action) => {
      if (!Object.hasOwn(labels, action)) throw new Error('Unknown Nova button');
      const id = randomBytes(18).toString('base64url');
      tokens.set(id, { ...scope, action, expiresAt: now() + ttlMs });
      while (tokens.size > maximum) tokens.delete(tokens.keys().next().value);
      return { type: 2, style: action === 'stop' ? 4 : 2, label: labels[action], custom_id: `nova:${id}` };
    });
    return [{ type: 1, components: buttons }];
  }
  function consume(customId, { userId, channelId }) {
    if (userId !== directMessageOwnerId) throw new Error('Nova controls are available only to the owner');
    const id = customId?.startsWith('nova:') ? customId.slice(5) : null;
    const value = tokens.get(id);
    if (!value || value.expiresAt <= now() || value.channelId !== channelId) throw new Error('This Nova control expired or belongs to another conversation');
    tokens.delete(id);
    return { action: value.action, value: value.action === 'retry' ? value.triggerMessageId : value.messageId, userId, channelId: value.channelId, guildId: value.guildId, directMessages: value.directMessages };
  }
  return { create, consume, recognizes: (customId) => customId?.startsWith('nova:') && tokens.has(customId.slice(5)), close: () => tokens.clear() };
}

export function renderControlResult(value) {
  if (typeof value === 'string') return value.slice(0, 1950);
  return '```json\n' + JSON.stringify(value, null, 2).slice(0, 1900).replaceAll('```', '~~~') + '\n```';
}
