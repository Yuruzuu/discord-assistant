import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { acquireCodexServer } from './codex-pool.mjs';
import { responderEnvironment } from './worker-environment.mjs';
import { z } from 'zod/v4';
import { isDeepStrictEqual } from 'node:util';

const appsServer = 'codex_apps';
const blockedSegments = new Set(['paypal', 'pay', 'payment', 'payments', 'payout', 'payouts', 'invoice', 'invoices', 'billing', 'checkout', 'wallet', 'bank', 'stripe', 'refund', 'refunds', 'transfer', 'transfers', 'purchase', 'purchases', 'subscription', 'subscriptions']);

// Only tools the connector itself marks read-only and non-destructive are exposed, and anything touching payments is refused outright.
export function isAllowedAppTool(name, annotations) {
  if (typeof name !== 'string' || !/^[a-z0-9_]+\.[A-Za-z0-9_.-]+$/.test(name)) return false;
  if (annotations?.readOnlyHint !== true || annotations.destructiveHint === true) return false;
  return !name.toLowerCase().split(/[._-]+/).some((segment) => blockedSegments.has(segment));
}

export function isAllowedAppAction(name, annotations) {
  return typeof name === 'string' && /^[a-z0-9_]+\.[A-Za-z0-9_.-]+$/.test(name) && annotations?.readOnlyHint === false
    && !name.toLowerCase().split(/[._-]+/).some((segment) => blockedSegments.has(segment));
}

// Connected apps run on a hidden Codex thread that never starts a model turn; the host calls tools on it directly, so the reply model never gets native app access.
export function createConnectedApps({ command = process.env.CODEX_CLI_PATH || 'codex', spawnImpl, acquire = acquireCodexServer, catalogTtlMs = 600000, startupTimeoutMs = 30000, callTimeoutMs = 60000, maxTextLength = 200000, sleep = wait, now = Date.now } = {}) {
  let server;
  let threadId;
  let directory;
  let startup;
  let catalog;
  let failure;
  let closed = false;

  async function reset() {
    const previous = server;
    const previousDirectory = directory;
    server = null; threadId = null; directory = null; startup = null; catalog = null; failure = null;
    await previous?.close();
    if (previousDirectory) await rm(previousDirectory, { recursive: true, force: true });
  }

  async function start() {
    directory = await mkdtemp(join(tmpdir(), 'nova-apps-'));
    server = await acquire({ command, env: responderEnvironment(), spawnImpl, onNotification: () => {},
      onToolCall: () => ({ success: false, contentItems: [{ type: 'inputText', text: 'Connected-app threads do not run model turns.' }] }),
      onFailure: (error) => { failure = error; } });
    const current = await server.request('config/read', { includeLayers: false });
    const disabledServers = Object.fromEntries(Object.keys(current.config.mcp_servers || {}).map((name) => [name, { enabled: false }]));
    const profile = `nova-apps-${randomUUID()}`;
    const result = await server.request('thread/start', {
      ephemeral: true, cwd: directory, approvalPolicy: 'never', permissions: profile, environments: [], selectedCapabilityRoots: [], dynamicTools: [],
      config: { mcp_servers: disabledServers, web_search: 'disabled', notify: [],
        permissions: { [profile]: { filesystem: { ':root': 'deny', [directory]: 'read' }, network: { enabled: false } } },
        features: { shell_tool: false, plugins: false, hooks: false, memories: false, js_repl: false, apps: true } },
    });
    if (!result.thread.ephemeral) throw new Error('Codex did not create an ephemeral connected-app thread');
    threadId = result.thread.id;
  }

  async function ready() {
    if (closed) throw new Error('Connected apps are stopped');
    if (failure || server?.isClosed()) await reset();
    if (!startup) startup = start().catch(async (error) => { await reset(); throw error; });
    await startup;
  }

  async function tools(signal) {
    await ready();
    if (catalog && now() - catalog.loadedAt < catalogTtlMs) return catalog.tools;
    const deadline = now() + startupTimeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const status = await server.request('mcpServerStatus/list', { threadId, limit: 100 });
      const entry = (status.data || []).find((item) => item.name === appsServer);
      if (entry?.toolsError) throw new Error(`Connected apps are unavailable: ${String(entry.toolsError).slice(0, 200)}`);
      if (entry && Object.keys(entry.tools || {}).length) {
        const allowed = new Map();
        for (const [name, tool] of Object.entries(entry.tools)) {
          if (!isAllowedAppTool(name, tool.annotations) && !isAllowedAppAction(name, tool.annotations)) continue;
          allowed.set(name, { name, app: name.split('.')[0], title: tool.title || tool.annotations?.title || null, description: String(tool.description || '').slice(0, 400), inputSchema: tool.inputSchema || { type: 'object' }, annotations: tool.annotations, access: isAllowedAppTool(name, tool.annotations) ? 'read' : 'action' });
        }
        catalog = { tools: allowed, loadedAt: now() };
        return allowed;
      }
      if (entry?.runtimeStatus === 'authenticationRequired') throw new Error('Connected apps need you to sign in to ChatGPT in Codex again');
      if (now() >= deadline) throw new Error('Connected apps did not finish loading; try again shortly');
      await sleep(500, undefined, signal ? { signal } : undefined);
    }
  }

  async function list({ app, query, limit = 40, access = 'read' } = {}, signal) {
    const available = [...(await tools(signal)).values()].filter((tool) => access === 'all' || tool.access === access);
    const apps = {};
    for (const tool of available) apps[tool.app] = (apps[tool.app] || 0) + 1;
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const matches = available.filter((tool) => (!app || tool.app === app) && terms.every((term) => `${tool.name} ${tool.title || ''} ${tool.description}`.toLowerCase().includes(term)));
    return { apps, matched: matches.length, tools: matches.slice(0, limit), nextStep: 'Call one tool with apps_call_tool using its exact name and arguments matching inputSchema.' };
  }

  async function call({ tool, arguments: args = {} }, signal) {
    const available = await tools(signal);
    if (available.get(tool)?.access !== 'read') throw new Error('That tool is not an approved read-only connected-app tool. Use apps_list_tools to find one.');
    return execute(tool, args, signal);
  }

  async function validateAction({ tool, arguments: args = {} }, signal) {
    const entry = (await tools(signal)).get(tool);
    if (entry?.access !== 'action') throw new Error('Choose a non-payment action from apps_list_tools with access: action.');
    let parsed;
    try { parsed = z.fromJSONSchema(entry.inputSchema).parse(args); }
    catch { throw new Error('Action arguments do not match the connected app schema.'); }
    return { tool, arguments: parsed, app: entry.app, title: entry.title || tool, destructive: entry.annotations.destructiveHint === true };
  }

  // This method is host-only. The model can prepare a proposal, but cannot call it or mint an approval.
  async function callApproved(action, signal) {
    catalog = null;
    const validated = await validateAction(action, signal);
    if (!isDeepStrictEqual(validated.arguments, action.arguments) || (action.destructive !== undefined && validated.destructive !== action.destructive)) throw Object.assign(new Error('The connected app schema or action changed; prepare a new proposal'), { approvalRejected: true });
    return execute(validated.tool, validated.arguments, signal);
  }

  async function execute(tool, args, signal) {
    signal?.throwIfAborted();
    const result = await server.request('mcpServer/tool/call', { server: appsServer, threadId, tool, arguments: args }, callTimeoutMs);
    signal?.throwIfAborted();
    const content = Array.isArray(result.content) ? result.content : [];
    let text = content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n');
    const truncated = text.length > maxTextLength;
    if (truncated) text = text.slice(0, maxTextLength);
    const toolImages = content.filter((item) => item?.type === 'image' && typeof item.data === 'string').map((item) => ({ mimeType: item.mimeType, data: item.data }));
    return { app: tool.split('.')[0], tool, isError: Boolean(result.isError), text, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(truncated ? { truncated: true } : {}), untrustedContent: true, privateOwnerData: true, toolImages };
  }

  async function close() { closed = true; await reset(); }

  return { list, call, validateAction, callApproved, close };
}
