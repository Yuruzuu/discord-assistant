import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCodexServer } from './codex-pool.mjs';
import { createReplyStream } from './reply-stream.mjs';
import { createReplyValidator } from './reply-validation.mjs';
import { responderEnvironment } from './worker-environment.mjs';
import { replySchema } from './reply-style.mjs';
import { loadInstructions } from '../instructions.mjs';
import { directMessageOwnerId } from './target.mjs';
import { replyDefaults } from './reply-defaults.mjs';
import { createContextProjector } from './context-projection.mjs';
import { createStageMetrics } from './stage-metrics.mjs';
import { createNativeTurn, waitForTurnOperation } from './native-turn.mjs';


function conversationIdentity(context) {
  return JSON.stringify({ channelId: context.channelId || null, guildId: context.guildId || null, directMessages: Boolean(context.directMessages) });
}

export function createConversationReply({ command = process.env.CODEX_CLI_PATH || 'codex', model = replyDefaults.model, reasoningEffort = replyDefaults.reasoningEffort, serviceTier = replyDefaults.serviceTier, timeoutMs = 120000, toolTimeoutMs = 30000, settlementTimeoutMs = 5000, maxToolCalls = 24, maxRepeatedFailures = 3, requireSubscription = false, spawnImpl, scope, readTools, webSearch = 'disabled', metrics = createStageMetrics() } = {}) {
  if (!['disabled', 'cached', 'indexed', 'live'].includes(webSearch)) throw new Error('webSearch must be disabled, cached, indexed or live');
  for (const value of [timeoutMs, toolTimeoutMs]) if (!Number.isInteger(value) || value < 1 || value > 900000) throw new Error('Conversation deadlines must be bounded positive milliseconds');
  if (!Number.isInteger(settlementTimeoutMs) || settlementTimeoutMs < 1 || settlementTimeoutMs > 30000) throw new Error('Settlement deadline must be a bounded positive duration');
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 100 || !Number.isInteger(maxRepeatedFailures) || maxRepeatedFailures < 1 || maxRepeatedFailures > 10) throw new Error('Conversation tool budgets must be bounded positive counts');
  let server;
  let directory;
  let threadId;
  let startup;
  let active;
  let responding = false;
  let identity = scope ? conversationIdentity(scope) : null;
  let closed = false;
  let newestContextId = null;
  let turns = 0;
  let usage = null;
  let permissionProfile;
  let catalogFingerprint;
  let lastDiagnostics = null;
  const projector = createContextProjector();
  const completedNativeIds = new Set();
  let latestProjection = null;
  let lastNativeStatus = null;
  const fingerprint = () => createHash('sha256').update(JSON.stringify(readTools?.definitions || [])).digest('hex');

  function failTurn(error) {
    if (!active || active.error) return;
    active.error = error;
    active.cancel.abort(error);
    active.reject(error);
  }

  function progress(turn, event) {
    try { void Promise.resolve(turn.onProgress?.(event, turn.signal)).catch(() => metrics.count('progress_errors')); }
    catch { metrics.count('progress_errors'); }
  }

  function acceptTerminal(turn, outcome) {
    if (!outcome || turn.terminalHandled) return;
    turn.terminalHandled = true;
    lastNativeStatus = outcome.status;
    completedNativeIds.add(outcome.id);
    if (completedNativeIds.size > 128) completedNativeIds.delete(completedNativeIds.values().next().value);
    turn.stopExecution?.();
    if (outcome.status === 'completed') turn.resolve();
    else failTurn(Object.assign(new Error(`Codex reply ${outcome.status}`), { code: 'NOVA_NATIVE_TERMINAL', nativeStatus: outcome.status }));
  }

  function bindTurn(turn, id) {
    turn.turnId = id;
    acceptTerminal(turn, turn.native.bind(id));
    const buffered = turn.earlyEvents.splice(0);
    turn.earlyBytes = 0;
    for (const event of buffered) if (event.parameters.turnId === id) receive(event.method, event.parameters);
  }

  function lateResponse(event) {
    metrics.count('late_rpc_responses');
    if (event.method !== 'turn/start' || event.params?.threadId !== threadId || !active || active.turnId) return;
    const id = event.result?.turn?.id;
    if (typeof id === 'string') { try { bindTurn(active, id); } catch (error) { failTurn(error); } }
  }

  function receive(method, parameters) {
    if (parameters?.threadId !== threadId) return;
    if (method === 'thread/tokenUsage/updated') { usage = parameters.tokenUsage; return; }
    if (method === 'thread/compacted' || (method === 'item/completed' && parameters.item?.type === 'contextCompaction')) {
      projector.reset(); newestContextId = null; metrics.count('native_compactions');
      return;
    }
    if (!active) return;
    if (method === 'turn/started') {
      const id = parameters.turn?.id;
      if (completedNativeIds.has(id)) return;
      try { bindTurn(active, id); } catch (error) { failTurn(error); }
      return;
    }
    if (method === 'turn/completed') {
      if (completedNativeIds.has(parameters.turn?.id) && parameters.turn?.id !== active.turnId) return;
      const outcome = active.native.observe(parameters.turn);
      if (!outcome && (!parameters.turn?.id || !['completed', 'failed', 'interrupted'].includes(parameters.turn.status))) metrics.count('malformed_completions');
      acceptTerminal(active, outcome);
      return;
    }
    if (active.turnId && parameters.turnId && parameters.turnId !== active.turnId) return;
    if (!active.turnId && ['item/started', 'item/completed', 'item/agentMessage/delta'].includes(method)) {
      if (completedNativeIds.has(parameters.turnId)) return;
      const bytes = Buffer.byteLength(JSON.stringify(parameters));
      if (active.earlyEvents.length >= 256 || active.earlyBytes + bytes > 1024 * 1024) { failTurn(Object.assign(new Error('Native events exceeded the pre-admission buffer'), { code: 'NOVA_NATIVE_PROTOCOL', novaFatal: true })); return; }
      active.earlyEvents.push({ method, parameters }); active.earlyBytes += bytes;
      return;
    }
    if (active.error) return;
    if (method === 'item/started' && parameters.item.type === 'agentMessage') {
      active.phases.set(parameters.item.id, parameters.item.phase || 'final_answer');
    } else if ((method === 'item/started' || method === 'item/completed') && parameters.item.type === 'webSearch') {
      // Codex runs web searches itself; report them like tool activity so the owner sees what was searched or opened.
      const { id, query, action } = parameters.item;
      const turn = active;
      progress(turn, { stage: method === 'item/started' ? 'started' : 'completed', toolName: 'web_search', callId: id,
        arguments: { query: query || action?.query || action?.queries?.[0] || '', url: action?.url || '' } });
    } else if (method === 'item/agentMessage/delta') {
      if (active.phases.get(parameters.itemId) === 'commentary') return;
      active.itemId ||= parameters.itemId;
      if (active.itemId !== parameters.itemId) { failTurn(Object.assign(new Error('Codex emitted multiple final reply items'), { novaFatal: true })); return; }
      if (!active.firstText) { active.firstText = true; metrics.record('model_first_text', metrics.now() - active.startedAt); }
      try { active.stream.push(parameters.delta); } catch (error) { error.novaFatal = true; failTurn(error); }
    } else if (method === 'item/completed' && parameters.item.type === 'agentMessage' && parameters.item.phase !== 'commentary') {
      if (!active.stream.text()) { try { active.stream.push(parameters.item.text); } catch (error) { error.novaFatal = true; failTurn(error); } }
    }
  }

  async function callTool(parameters) {
    const turn = active;
    const failure = (text) => ({ success: false, contentItems: [{ type: 'inputText', text }] });
    if (!turn || turn.error || turn.native.outcome() || parameters.threadId !== threadId || typeof parameters.turnId !== 'string' || completedNativeIds.has(parameters.turnId) || (turn.turnId && parameters.turnId !== turn.turnId)) return failure('This conversation turn is not active.');
    if (parameters.namespace || !readTools?.has(parameters.tool)) return failure('Only the supplied approved reading tools are available.');
    if (turn.toolCalls.has(parameters.callId)) return turn.toolCalls.get(parameters.callId);
    if (turn.toolCalls.size >= maxToolCalls) return failure('This reply reached its reading tool limit. Summarize verified findings and any remaining gaps.');
    const callKey = JSON.stringify([parameters.tool, parameters.arguments]);
    const blocked = (text) => {
      const result = Promise.resolve(failure(text));
      turn.toolCalls.set(parameters.callId, result);
      return result;
    };
    if ((turn.failures.get(callKey) || 0) >= maxRepeatedFailures) return blocked('This tool repeatedly failed with the same arguments. Change the query or report the verified limitation.');
    if ((turn.results.get(callKey)?.repetitions || 0) >= 3) return blocked('This read repeatedly returned the same result. Use a different query, continuation or context request rather than repeating it.');
    const operation = Promise.resolve().then(async () => {
      const stopTool = metrics.start('tool'); metrics.count('tool_calls');
      try {
        turn.signal.throwIfAborted();
        if (!turn.turnId) {
          let abortAdmission;
          try {
            await Promise.race([turn.native.bound, new Promise((_, reject) => {
              abortAdmission = () => reject(turn.signal.reason);
              turn.signal.addEventListener('abort', abortAdmission, { once: true });
              if (turn.signal.aborted) abortAdmission();
            })]);
          } finally { if (abortAdmission) turn.signal.removeEventListener('abort', abortAdmission); }
        }
        if (active !== turn || parameters.turnId !== turn.turnId || turn.native.outcome()) return failure('This conversation turn is not active.');
        progress(turn, { stage: 'started', toolName: parameters.tool, callId: parameters.callId, arguments: parameters.arguments });
        turn.signal.throwIfAborted();
        const toolSignal = AbortSignal.any([turn.signal, AbortSignal.timeout(toolTimeoutMs)]);
        let abortTool;
        let result;
        try {
          result = await Promise.race([
            readTools.call(parameters.tool, parameters.arguments, toolSignal),
            new Promise((resolve, reject) => {
              abortTool = () => reject(toolSignal.reason);
              if (toolSignal.aborted) abortTool();
              else toolSignal.addEventListener('abort', abortTool, { once: true });
            }),
          ]);
        } finally { if (abortTool) toolSignal.removeEventListener('abort', abortTool); }
        // Image results can carry megabytes of base64, so serialize once for both the size check and the repeat fingerprint.
        const serialized = Array.isArray(result.contentItems) ? JSON.stringify(result.contentItems) : null;
        if (serialized === null || Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('Tool result exceeded the response content budget');
        if (!result.success) turn.failures.set(callKey, (turn.failures.get(callKey) || 0) + 1);
        else {
          const resultFingerprint = createHash('sha256').update(serialized).digest('hex');
          const previous = turn.results.get(callKey);
          turn.results.set(callKey, { fingerprint: resultFingerprint, repetitions: previous?.fingerprint === resultFingerprint ? previous.repetitions + 1 : 1 });
        }
        turn.signal.throwIfAborted();
        progress(turn, { stage: 'completed', toolName: parameters.tool, callId: parameters.callId, arguments: parameters.arguments, resultCount: result.resultCount });
        return { success: result.success, contentItems: result.contentItems };
      } catch (error) {
        turn.failures.set(callKey, (turn.failures.get(callKey) || 0) + 1);
        metrics.count('tool_failures');
        if (!turn.signal.aborted) progress(turn, { stage: 'failed', toolName: parameters.tool, callId: parameters.callId, arguments: parameters.arguments });
        return failure(turn.signal.aborted ? 'Conversation stopped.' : readTools.errorMessage(error));
      } finally { stopTool(); }
    });
    turn.toolCalls.set(parameters.callId, operation);
    return operation;
  }

  async function abandonStart() { await reset(); throw new Error('The Codex conversation is stopped'); }

  async function start(signal) {
    const stopStartup = metrics.start('worker_startup');
    try {
      if (closed) throw new Error('The Codex conversation is stopped');
      directory = await mkdtemp(join(tmpdir(), 'nova-conversation-'));
      if (closed) await abandonStart();
      server = await acquireCodexServer({ command, env: responderEnvironment(), spawnImpl, signal, onNotification: receive, onToolCall: callTool, onFailure: failTurn, onLateResponse: lateResponse });
      if (closed) await abandonStart();
      if (requireSubscription) {
        const account = await server.request('account/read', { refreshToken: false }, { signal });
        if (account.account?.type !== 'chatgpt') throw new Error('Nova requires a saved ChatGPT subscription login. Run codex login with your ChatGPT account before starting it.');
        lastDiagnostics = { authType: 'chatgpt' };
      }
      const current = await server.request('config/read', { includeLayers: false }, { signal });
      const disabledServers = Object.fromEntries(Object.keys(current.config.mcp_servers || {}).map((name) => [name, { enabled: false }]));
      permissionProfile = `nova-${randomUUID()}`;
      const result = await server.request('thread/start', {
        ephemeral: true, model, serviceTier, cwd: directory, approvalPolicy: 'never', permissions: permissionProfile,
        environments: [], selectedCapabilityRoots: [], baseInstructions: loadInstructions('nova', { ownerUserId: directMessageOwnerId }), dynamicTools: readTools?.definitions || [],
        config: { mcp_servers: disabledServers, web_search: webSearch, notify: [], model_reasoning_effort: reasoningEffort,
          permissions: { [permissionProfile]: { filesystem: { ':root': 'deny', [directory]: 'read' }, network: { enabled: false } } },
          features: { shell_tool: false, plugins: false, hooks: false, memories: false, js_repl: false, apps: false } },
      }, { signal });
      if (closed) await abandonStart();
      if (!result.thread.ephemeral) throw new Error('Codex did not create an ephemeral conversation');
      threadId = result.thread.id;
      catalogFingerprint = fingerprint();
      const registered = await server.request('mcpServerStatus/list', { threadId, limit: 100 }, { signal });
      if (registered.data.some((entry) => Object.keys(entry.tools || {}).length)) throw new Error('Nova worker unexpectedly loaded MCP tools');
    } finally { stopStartup(); }
  }

  async function warmup(signal) {
    signal?.throwIfAborted();
    const catalogChanged = Boolean(threadId) && catalogFingerprint !== fingerprint();
    if (active && catalogChanged) throw new Error('Cannot change the tool catalog during an active answer');
    if (server?.isClosed() || catalogChanged) await reset();
    if (!startup) startup = start(signal).catch(async (error) => { await reset(); throw error; });
    await startup;
  }

  async function reset() {
    const previous = server;
    const previousDirectory = directory;
    directory = null;
    server = null; startup = null; threadId = null; newestContextId = null; usage = null;
    projector.reset(); completedNativeIds.clear(); latestProjection = null; lastNativeStatus = null;
    if (previous) await previous.close();
    if (previousDirectory) await rm(previousDirectory, { recursive: true, force: true });
  }

  async function interruptNative(turn) {
    if (turn.native.outcome() || !turn.turnId || !server || server.isClosed()) return;
    if (!turn.interrupting) turn.interrupting = server.request('turn/interrupt', { threadId, turnId: turn.turnId }, { timeoutMs: settlementTimeoutMs }).catch(() => {});
    await turn.interrupting;
  }

  async function recoverTurn(turn, error) {
    turn.error ||= error;
    turn.cancel.abort();
    const stopSettlement = metrics.start('settlement');
    const began = metrics.now();
    try {
      if (!turn.turnId && error.writeOutcome === 'not-written' && server && !server.isClosed() && !error.novaFatal && !closed) {
        projector.reset(); newestContextId = null; metrics.count('retained_threads');
        return;
      }
      await interruptNative(turn);
      const remaining = Math.max(1, settlementTimeoutMs - (metrics.now() - began));
      const outcome = await turn.native.wait(remaining);
      if (outcome && server && !server.isClosed() && !error.novaFatal && !closed) {
        projector.reset(); newestContextId = null;
        metrics.count('retained_threads');
        return;
      }
      metrics.count('retired_threads');
      await server?.retireThread?.();
      await reset();
    } finally { stopSettlement(); }
  }

  async function runTurn(context, signal, { onMessage, onProgress } = {}) {
    if (active) throw new Error('A reply is already active in this conversation');
    const requestedIdentity = conversationIdentity(context);
    if (identity && identity !== requestedIdentity) throw new Error('Cannot share a Codex thread across Discord conversations');
    identity ||= requestedIdentity;
    signal?.throwIfAborted();
    await warmup(signal);
    signal?.throwIfAborted();
    let resolve;
    let reject;
    const completion = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    completion.catch(() => {});
    const published = [];
    readTools?.beginTurn?.();
    const validator = createReplyValidator(context);
    const turn = { resolve, reject, native: createNativeTurn(), earlyEvents: [], earlyBytes: 0, startedAt: metrics.now(), stopExecution: metrics.start('native_execution'), phases: new Map(), delivery: Promise.resolve(), turnId: null, error: null, cancel: new AbortController(), toolCalls: new Map(), failures: new Map(), results: new Map(), onProgress };
    const deliverySignal = signal ? AbortSignal.any([signal, turn.cancel.signal]) : turn.cancel.signal;
    turn.signal = deliverySignal;
    turn.stream = createReplyStream((raw, index) => {
      let message;
      try { message = validator.message(raw); } catch (error) { error.novaFatal = true; throw error; }
      if (!onMessage) return;
      turn.delivery = turn.delivery.then(async () => {
        deliverySignal.throwIfAborted();
        await onMessage(message, index, deliverySignal);
        published.push(message);
      });
      turn.delivery.catch(failTurn);
    });
    active = turn;
    const timer = setTimeout(() => failTurn(Object.assign(new Error(turn.native.outcome()?.status === 'completed' ? 'Reply delivery exceeded the turn deadline' : 'Codex reply generation timed out'), { code: 'NOVA_TURN_TIMEOUT' })), timeoutMs);
    const abort = () => failTurn(new DOMException('Proactive listener stopped', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    const nearby = (context.recentMessages || []).filter((message) => !newestContextId || BigInt(message.id) > BigInt(newestContextId));
    const { images = [], ...textContext } = context;
    const selectedImages = images.filter((image) => /^data:image\/(?:png|jpeg|webp|gif);base64,/.test(image.imageUrl || '')).slice(0, 8);
    const prepared = projector.prepare({ ...textContext, recentMessages: nearby,
      ...(selectedImages.length ? { imageSources: selectedImages.map((image, index) => ({ index, sourceMessageId: /^\d{17,20}$/.test(image.sourceMessageId || '') ? image.sourceMessageId : null, ...(image.pageNumber ? { pageNumber: image.pageNumber, attachmentId: image.attachmentId } : {}) })) } : {}),
    });
    latestProjection = prepared.metrics;
    metrics.count('projected_context_bytes', prepared.metrics.projectedBytes);
    metrics.count('snapshot_bytes_saved', prepared.metrics.snapshotBytesSaved);
    const imageInputs = selectedImages.map((image) => ({ type: 'image', url: image.imageUrl }));
    try {
      const started = await metrics.measure('turn_admission', () => server.request('turn/start', {
        threadId, input: [{ type: 'text', text: JSON.stringify(prepared.input) }, ...imageInputs], model, effort: reasoningEffort, serviceTier,
        outputSchema: replySchema, approvalPolicy: 'never', environments: [], permissions: permissionProfile,
      }, { signal: turn.signal }));
      bindTurn(turn, started.turn?.id);
      if (signal?.aborted) abort();
      await completion;
      await waitForTurnOperation(turn.delivery, turn.signal);
      let plan;
      try { plan = validator.plan(JSON.parse(turn.stream.text())); }
      catch (error) { error.novaFatal = true; throw error; }
      if (published.length && (!plan.shouldReply || published.some((message, index) => JSON.stringify(message) !== JSON.stringify(plan.messages[index])))) {
        throw Object.assign(new Error('Codex changed a reply bubble after publishing it'), { novaFatal: true });
      }
      if (prepared.commit()) for (const message of [...nearby, ...(context.triggerMessages || [])]) {
        if (message.id && (!newestContextId || BigInt(message.id) > BigInt(newestContextId))) newestContextId = message.id;
      }
      turns += 1;
      return plan;
    } catch (error) {
      await recoverTurn(turn, error);
      let drain;
      try { await Promise.race([turn.delivery.catch(() => {}), new Promise((accept) => { drain = setTimeout(accept, settlementTimeoutMs); })]); }
      finally { clearTimeout(drain); }
      active = null;
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      turn.stopExecution();
      if (active === turn) active = null;
    }
  }

  async function respond(context, signal, options) {
    if (responding) throw new Error('A reply is already active in this conversation');
    responding = true;
    try { return await runTurn(context, signal, options); }
    finally { responding = false; }
  }

  respond.warmup = warmup;
  respond.interrupt = async () => {
    if (!active) return { interrupted: false };
    const turn = active;
    failTurn(new DOMException('Answer interrupted by owner', 'AbortError'));
    await interruptNative(turn);
    return { interrupted: true };
  };
  respond.steer = async (text, options = {}, signal) => {
    signal?.throwIfAborted();
    if (!active?.turnId || active.error) return { accepted: false };
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Steering requires a nonempty correction of at most 16000 characters');
    const turn = active;
    const result = await server.request('turn/steer', { threadId, expectedTurnId: turn.turnId, input: [{ type: 'text', text }], ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}) });
    return { accepted: true, turnId: result.turnId || turn.turnId };
  };
  respond.configure = async (configuration) => {
    if (responding) throw new Error('Stop the active answer before changing its settings');
    for (const key of Object.keys(configuration)) if (!['model', 'reasoningEffort', 'serviceTier', 'timeoutMs', 'toolTimeoutMs', 'maxToolCalls'].includes(key)) throw new Error('Unsupported conversation setting');
    if (configuration.model !== undefined && (typeof configuration.model !== 'string' || !configuration.model.trim())) throw new Error('Model must be a nonempty string');
    if (configuration.reasoningEffort !== undefined && (typeof configuration.reasoningEffort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(configuration.reasoningEffort))) throw new Error('Reasoning effort must be a nonempty advertised effort name');
    if (configuration.serviceTier !== undefined && ![null, 'auto', 'default', 'priority', 'flex'].includes(configuration.serviceTier)) throw new Error('Unsupported service tier');
    for (const key of ['timeoutMs', 'toolTimeoutMs']) if (configuration[key] !== undefined && (!Number.isInteger(configuration[key]) || configuration[key] < 1000 || configuration[key] > 900000)) throw new Error('Timeout must be between 1000 and 900000 milliseconds');
    if (configuration.maxToolCalls !== undefined && (!Number.isInteger(configuration.maxToolCalls) || configuration.maxToolCalls < 1 || configuration.maxToolCalls > 100)) throw new Error('Tool budget must be between 1 and 100');
    const providerChanged = (configuration.model !== undefined && configuration.model !== model) || (configuration.reasoningEffort !== undefined && configuration.reasoningEffort !== reasoningEffort) || ('serviceTier' in configuration && configuration.serviceTier !== serviceTier);
    if (providerChanged && ['failed', 'interrupted'].includes(lastNativeStatus)) await reset();
    model = configuration.model ?? model;
    reasoningEffort = configuration.reasoningEffort ?? reasoningEffort;
    if ('serviceTier' in configuration) serviceTier = configuration.serviceTier;
    timeoutMs = configuration.timeoutMs ?? timeoutMs;
    toolTimeoutMs = configuration.toolTimeoutMs ?? toolTimeoutMs;
    maxToolCalls = configuration.maxToolCalls ?? maxToolCalls;
    return respond.status();
  };
  respond.diagnostics = async () => {
    await warmup();
    const [account, rateLimits, models] = await Promise.all([
      server.request('account/read', { refreshToken: false }),
      server.request('account/rateLimits/read', {}),
      server.request('model/list', { limit: 100 }),
    ]);
    lastDiagnostics = { authType: account.account?.type || null, requiresOpenaiAuth: account.requiresOpenaiAuth, rateLimits: rateLimits.rateLimits || null, rateLimitsByLimitId: rateLimits.rateLimitsByLimitId || null,
      models: (models.data || []).map((entry) => ({ id: entry.id, model: entry.model, displayName: entry.displayName, supportedReasoningEfforts: entry.supportedReasoningEfforts })) };
    return { ...lastDiagnostics, ...respond.status() };
  };
  respond.reset = async () => {
    if (responding) throw new Error('Stop the active answer before resetting the conversation');
    await reset();
    turns = 0;
    return respond.status();
  };
  respond.compact = async () => {
    if (responding) throw new Error('Wait for the active answer before compacting the conversation');
    await warmup();
    projector.reset(); newestContextId = null;
    await server.request('thread/compact/start', { threadId });
    return { requested: true };
  };
  respond.close = async () => { closed = true; failTurn(new DOMException('Conversation stopped', 'AbortError')); if (active) await interruptNative(active); await reset(); };
  respond.status = () => ({ threadId, ephemeral: true, turns, active: responding, sharedWorkerConversations: server?.peers() || 0, model, reasoningEffort, requestedServiceTier: serviceTier, actualServiceTier: null, timeoutMs, toolTimeoutMs, maxToolCalls, authType: lastDiagnostics?.authType || null, rateLimits: lastDiagnostics?.rateLimits || null, cachedInputTokens: usage?.last.cachedInputTokens || 0, inputTokens: usage?.last.inputTokens || 0, outputTokens: usage?.last.outputTokens || 0, contextProjection: latestProjection, performance: metrics.snapshot() });
  return respond;
}
