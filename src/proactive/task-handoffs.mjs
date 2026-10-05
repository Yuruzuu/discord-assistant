import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { directMessageOwnerId } from './target.mjs';
import { proactiveRoot, writeState } from './state.mjs';
import { createT3Client } from './t3-client.mjs';

const harnessDrivers = { codex: 'codex', 'claude-code': 'claudeAgent' };
const terminalStates = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
const boundedText = (value, limit, label) => { if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} requires 1 to ${limit} characters`); return value.trim(); };

export function sanitizeHandoffCommand(value) {
  return String(value || '').replace(/\b(?:Bearer\s+|sk-[A-Za-z0-9_-]*|gh[pousr]_[A-Za-z0-9_]*|mfa\.[A-Za-z0-9_-]+)[A-Za-z0-9._-]*/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/((?:token|password|secret|api[_-]?key|authorization|credential)[A-Za-z0-9_-]*\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/```/g, 'ʼʼʼ').replace(/\u0000/g, '').slice(0, 1400);
}

export function createTaskHandoffs({ client = createT3Client(), root = join(proactiveRoot(), 'task-handoffs'), approvedProjectIds, onProgress = () => {}, onApproval = () => {}, onComplete = () => {}, onError = () => {}, pollMs = 10000 } = {}) {
  const tasks = new Map();
  let closed = false;
  async function deliverNotification(callback, value) {
    try { await callback(value); }
    catch { try { onError(new Error('A T3 task notification could not be delivered')); } catch {} }
  }
  function owner(actor = {}, mutation = false) {
    if (actor.userId !== directMessageOwnerId || actor.guildId) throw new Error('Task handoffs are available only in the owner DM');
    if (mutation && actor.explicitOwnerAction !== true) throw new Error('The owner must explicitly approve this task action');
    if (closed) throw new Error('Task handoffs are closed');
  }
  function snapshot(task) {
    return { id: task.id, threadId: task.threadId || null, projectId: task.projectId, project: task.project, harness: task.harness, model: task.model,
      title: task.title, channelId: task.channelId, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt, error: task.error || null,
      pendingApprovals: [...task.approvals.values()], latestReply: task.latestReply || null };
  }
  async function persist(task) {
    const value = snapshot(task);
    // Keep prompts, command contents, provider approvals and replies out of durable state.
    delete value.pendingApprovals; delete value.latestReply;
    task.writes = task.writes.catch(() => {}).then(() => writeState(join(root, `${task.id}.json`), value));
    return task.writes;
  }
  async function catalog(actor) {
    owner(actor);
    const [configuration, projects] = await Promise.all([client.request('server.getConfig'), client.projects()]);
    const providers = (configuration.providers || []).filter((provider) => Object.values(harnessDrivers).includes(provider.driver) && provider.enabled && provider.installed && provider.auth?.status === 'authenticated');
    return {
      projects: projects.filter((project) => !approvedProjectIds || approvedProjectIds.includes(project.id)).map(({ id, title, workspaceRoot }) => ({ id, name: title, workspaceRoot })),
      providers: providers.map((provider) => ({ instanceId: provider.instanceId, harness: Object.keys(harnessDrivers).find((name) => harnessDrivers[name] === provider.driver), models: provider.models.map(({ slug, name, isDefault }) => ({ id: slug, name, default: Boolean(isDefault) })) })),
    };
  }
  function taskFor(id, actor) {
    const task = tasks.get(id);
    if (!task || (actor?.channelId && task.channelId !== actor.channelId)) throw new Error('Unknown Nova handoff task in this owner DM');
    return task;
  }
  function currentRun(projection) { return [...(projection.runs || [])].sort((left, right) => right.ordinal - left.ordinal)[0]; }
  function items(projection) { return projection.turnItems || projection.visibleTurnItems?.map((entry) => entry.item) || []; }
  async function observe(task, projection, notify = true) {
    const run = currentRun(projection);
    const previous = task.state;
    task.state = run?.status || 'queued'; task.updatedAt = Date.now(); task.runId = run?.id;
    task.projection = projection;
    const activity = items(projection);
    for (const item of activity) {
      if (item.type === 'assistant_message' && !item.streaming && item.text) task.latestReply = sanitizeHandoffCommand(item.text).slice(0, 1400);
      if (!['command_execution', 'dynamic_tool', 'file_search', 'web_search', 'file_change'].includes(item.type)) continue;
      const fingerprint = `${item.id}:${item.status}`;
      if (task.seen.has(fingerprint)) continue;
      task.seen.add(fingerprint);
      if (notify) await deliverNotification(onProgress, { taskId: task.id, channelId: task.channelId, harness: task.harness, title: task.title, itemId: item.id, state: item.status,
        type: item.type, command: sanitizeHandoffCommand(item.type === 'command_execution' ? item.input : item.toolName || item.pattern || item.title || item.type), tool: item.toolName || item.type });
    }
    task.approvals.clear();
    for (const pending of projection.runtimeRequests || []) {
      if (pending.status !== 'pending' || !['command', 'file-read', 'file-change', 'mcp-elicitation', 'permission'].includes(pending.kind) || pending.responseCapability?.type === 'not_resumable') continue;
      const item = activity.find((entry) => entry.type === 'approval_request' && entry.requestId === pending.id);
      if (!item) continue;
      const commandItem = activity.find((entry) => entry.nodeId === pending.nodeId && entry.type === 'command_execution');
      const choices = item.options?.map((option) => option.decision) || ['accept', 'decline', 'cancel'];
      const approval = { taskId: task.id, requestId: pending.id, channelId: task.channelId, kind: pending.kind,
        command: sanitizeHandoffCommand(commandItem?.input || item.prompt || item.title || pending.kind), decisions: choices.filter((decision) => ['accept', 'decline', 'cancel'].includes(decision)) };
      task.approvals.set(pending.id, approval);
      if (notify && !task.announcedApprovals.has(pending.id)) { task.announcedApprovals.add(pending.id); await deliverNotification(onApproval, approval); }
    }
    if (task.state !== previous) {
      await persist(task);
      if (notify && terminalStates.has(task.state)) await deliverNotification(onComplete, snapshot(task));
    }
    return snapshot(task);
  }
  async function refresh(task, notify = true) {
    if (!task.threadId) return snapshot(task);
    if (task.refreshing) return task.refreshing;
    task.refreshing = client.request('orchestration.getThreadProjection', { threadId: task.threadId }).then((projection) => observe(task, projection, notify)).finally(() => { task.refreshing = null; });
    return task.refreshing;
  }
  async function monitor(task) {
    if (!task.threadId || closed || task.unsubscribe) return;
    task.unsubscribe = await client.subscribe(task.threadId, async (value) => {
      if (closed) return;
      if (value.kind === 'snapshot') await observe(task, value.projection);
      else if (value.kind === 'event') await refresh(task);
    });
  }
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const filename of await readdir(root)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
      const saved = JSON.parse(await readFile(join(root, filename), 'utf8'));
      if (!identifier(saved.id) || (saved.threadId && !identifier(saved.threadId)) || !harnessDrivers[saved.harness]) continue;
      const task = { ...saved, approvals: new Map(), seen: new Set(), announcedApprovals: new Set(), writes: Promise.resolve() };
      if (!task.threadId && !terminalStates.has(task.state)) { task.state = 'failed'; task.error = 'Task launch was interrupted; inspect T3 before creating another task'; }
      tasks.set(task.id, task);
    }
  })();
  const timer = setInterval(() => {
    if (closed) return;
    for (const task of tasks.values()) if (task.threadId && !terminalStates.has(task.state)) void refresh(task).then(() => monitor(task)).catch(() => { task.unsubscribe?.(); task.unsubscribe = null; onError(new Error('T3 task status is temporarily unavailable')); });
  }, pollMs);
  timer.unref?.();

  async function start(options = {}) {
    owner(options, true); await ready;
    const request = boundedText(options.request, 32000, 'Task request');
    const title = boundedText(options.title, 120, 'Task title');
    if (!harnessDrivers[options.harness]) throw new Error('Choose codex or claude-code');
    if (!/^\d{17,20}$/.test(options.channelId)) throw new Error('Provide the owner DM channel');
    const available = await catalog(options);
    const project = available.projects.find((entry) => entry.id === options.projectId);
    const provider = available.providers.find((entry) => entry.harness === options.harness && (!options.instanceId || entry.instanceId === options.instanceId));
    if (!project) throw new Error('Choose a project from the approved T3 project catalog');
    await realpath(project.workspaceRoot);
    if (!provider) throw new Error('The selected T3 harness is not connected and authenticated');
    const model = provider.models.find((entry) => entry.id === options.model);
    if (!model) throw new Error('Choose a model from this T3 harness catalog');
    const task = { id: randomUUID(), threadId: null, projectId: project.id, project: project.name, harness: options.harness, model: model.id, title,
      channelId: options.channelId, state: 'starting', createdAt: Date.now(), updatedAt: Date.now(), approvals: new Map(), seen: new Set(), announcedApprovals: new Set(), writes: Promise.resolve() };
    task.threadId = task.id;
    tasks.set(task.id, task); await persist(task);
    let confirmed = false;
    try {
      const launched = await client.request('orchestration.launchThread', { commandId: task.id, threadId: task.id, creationSource: 'mcp', projectId: project.id, title,
        generateTitle: false, modelSelection: { instanceId: provider.instanceId, model: model.id }, runtimeMode: 'approval-required', interactionMode: 'default',
        workspaceStrategy: { type: 'root' }, initialMessage: { messageId: randomUUID(), text: request, attachments: [] } });
      task.threadId = launched.threadId;
      if (!identifier(task.threadId)) throw new Error('T3 did not confirm the launched thread');
      confirmed = true;
      await persist(task); await observe(task, launched.projection); await monitor(task);
      return snapshot(task);
    } catch (error) {
      if (!confirmed) { task.state = 'unconfirmed'; task.error = 'Task launch could not be confirmed; inspect T3 before retrying'; await persist(task); }
      throw new Error(task.error || 'Task started in T3 but its monitor could not connect', { cause: error });
    }
  }
  async function status(id, actor) { owner(actor); await ready; return refresh(taskFor(id, actor)); }
  async function list(actor) { owner(actor); await ready; return [...tasks.values()].filter((task) => !actor?.channelId || task.channelId === actor.channelId).map(snapshot); }
  async function steer(id, request, actor) {
    owner(actor, true); await ready;
    const task = taskFor(id, actor); const text = boundedText(request, 32000, 'Task steering');
    await refresh(task);
    await client.request('orchestration.dispatchCommand', { type: 'message.dispatch', commandId: randomUUID(), threadId: task.threadId,
      createdBy: 'user', creationSource: 'mcp', messageId: randomUUID(), text, attachments: [],
      dispatchMode: terminalStates.has(task.state) ? { type: 'start_immediately' } : ['running', 'waiting'].includes(task.state) ? { type: 'steer_active', targetRunId: task.runId } : { type: 'queue_after_active' } });
    return refresh(task);
  }
  async function stop(id, actor) {
    owner(actor, true); await ready;
    const task = taskFor(id, actor); await refresh(task);
    if (terminalStates.has(task.state)) return snapshot(task);
    const runs = task.projection.runs.filter((run) => !terminalStates.has(run.status)).sort((left, right) => Number(left.status !== 'queued') - Number(right.status !== 'queued'));
    for (const run of runs) await client.request('orchestration.dispatchCommand', { type: run.status === 'queued' ? 'queued-run.cancel' : 'run.interrupt', commandId: randomUUID(), threadId: task.threadId, runId: run.id,
      ...(run.status === 'queued' ? {} : { holdQueue: true, reason: 'Stopped explicitly by the Discord owner' }) });
    return refresh(task);
  }
  async function respondApproval(id, requestId, decision, actor) {
    owner(actor, true); await ready;
    const task = taskFor(id, actor); await refresh(task);
    const approval = task.approvals.get(requestId);
    if (!approval || !approval.decisions.includes(decision)) throw new Error('This exact task approval is unavailable or expired');
    await client.request('orchestration.dispatchCommand', { type: 'runtime-request.respond', commandId: randomUUID(), threadId: task.threadId, requestId, decision });
    return refresh(task);
  }
  return { start, status, list, steer, stop, respondApproval, catalog, ready: () => ready, close: async () => { closed = true; clearInterval(timer); await ready; for (const task of tasks.values()) task.unsubscribe?.(); await client.close(); await Promise.allSettled([...tasks.values()].map((task) => task.writes)); } };
}
