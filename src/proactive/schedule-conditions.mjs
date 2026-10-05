import { z } from 'zod/v4';
import { searchMessages } from '../search.mjs';
import { compareSnowflakes } from '../discord-url.mjs';

const identifier = z.string().regex(/^\d{17,20}$/);
const pathSchema = z.array(z.union([z.string().min(1).max(100).refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value)), z.number().int().min(0).max(1000)])).min(1).max(12);
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
const predicateSchema = z.discriminatedUnion('operator', [
  z.object({ path: pathSchema, operator: z.literal('equals'), value: scalar }).strict(),
  z.object({ path: pathSchema, operator: z.literal('includes'), value: scalar }).strict(),
  z.object({ path: pathSchema, operator: z.literal('exists') }).strict(),
]);

function boundedArguments(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { return false; }
  if (!encoded || encoded.length > 8192) return false;
  let keys = 0;
  const visit = (item, depth) => {
    if (depth > 8) return false;
    if (item === null || typeof item !== 'object') return true;
    return Object.entries(item).every(([key, child]) => ++keys <= 200 && !['__proto__', 'prototype', 'constructor', 'token', 'password', 'authorization', 'cookie', 'api_key', 'apikey'].includes(key.toLowerCase()) && visit(child, depth + 1));
  };
  return visit(value, 0);
}

export const scheduleConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('discord'), guildId: identifier, query: z.string().max(1024).default(''), authorIds: z.array(identifier).max(25).default([]), channelIds: z.array(identifier).max(25).default([]) }).strict(),
  z.object({ type: z.literal('app'), tool: z.string().regex(/^[a-z0-9_]+\.[A-Za-z0-9_.-]+$/), arguments: z.record(z.string(), z.unknown()).refine(boundedArguments, 'Alert arguments must be bounded JSON without credentials').default({}), predicate: predicateSchema }).strict(),
]).refine((value) => value.type !== 'discord' || value.query.trim() || value.authorIds.length || value.channelIds.length, 'Choose an alert topic, channel or author');

export function evaluateSchedulePredicate(value, predicate) {
  let selected = value;
  for (const segment of predicate.path) {
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, segment)) { selected = undefined; break; }
    selected = selected[segment];
  }
  if (predicate.operator === 'exists') return selected !== undefined && selected !== null;
  if (predicate.operator === 'equals') return selected === predicate.value;
  return typeof selected === 'string' && typeof predicate.value === 'string' ? selected.includes(predicate.value) : Array.isArray(selected) && selected.includes(predicate.value);
}

export async function validateScheduleCondition(condition, { service, accountId, apps, signal } = {}) {
  const parsed = scheduleConditionSchema.parse(condition);
  signal?.throwIfAborted();
  if (parsed.type === 'app') {
    if (!apps?.list || !apps?.call) throw new Error('Connected-app alerts are unavailable');
    const catalog = await apps.list({ app: parsed.tool.split('.')[0], limit: 100 }, signal);
    if (!catalog.tools.some((tool) => tool.name === parsed.tool)) throw new Error('Alerts require an available read-only connected-app tool');
    return parsed;
  }
  const client = service.accountById(accountId).client;
  await client.getGuild(parsed.guildId, { signal });
  for (const channelId of parsed.channelIds) {
    const channel = await client.getChannel(channelId, { signal });
    if ((channel.guild_id || channel.guildId) !== parsed.guildId) throw new Error('Alert channel belongs to a different server');
  }
  signal?.throwIfAborted();
  return parsed;
}

export async function checkScheduleCondition(schedule, { service, accountId, apps, signal } = {}) {
  const condition = schedule.condition;
  if (condition.type === 'app') {
    const result = await apps.call({ tool: condition.tool, arguments: condition.arguments }, signal);
    if (result.isError) throw new Error('Connected-app alert check failed');
    let value = result.structuredContent;
    if (value === undefined) {
      try { value = JSON.parse(result.text); } catch { throw new Error('Alert tool must return structured data or a JSON text result'); }
    }
    return { matched: evaluateSchedulePredicate(value, condition.predicate), privateOwnerData: true };
  }
  const result = await searchMessages(service, { ...condition, type: undefined, accountId, afterId: schedule.afterId, limit: 25, sortBy: 'timestamp', sortOrder: 'asc' }, { signal });
  if (result.doingHistoricalIndex) throw new Error('Discord is still indexing this alert search');
  const messages = result.messages.filter((message) => compareSnowflakes(message.id, schedule.afterId) > 0).sort((left, right) => compareSnowflakes(left.id, right.id));
  return { matched: messages.length > 0, throughId: messages.at(-1)?.id, links: messages.slice(0, 5).map((message) => message.url || `https://discord.com/channels/${condition.guildId}/${message.channelId}/${message.id}`), continuation: result.hasMore };
}
