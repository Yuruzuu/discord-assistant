import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

export function fakeCodexServer({ plans, hang = false, tools = {}, toolCalls = [], events = [], delayMs = 5, closeDelayMs = 0, accountType = 'chatgpt' } = {}) {
  const requests = [];
  const launches = [];
  const children = [];
  const toolResponses = [];
  let startedThreads = 0;
  let completedTurns = 0;
  const defaultMessage = { content: 'hey!', gifUrl: null, stickerIds: [] };
  const spawnImpl = (command, args, options) => {
    launches.push({ command, args, options });
    const child = new EventEmitter();
    children.push(child);
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null;
    let stopped = false;
    let turns = 0;
    const timers = new Set();
    const toolWaiters = new Map();
    function emit(value) { if (!stopped) child.stdout.write(JSON.stringify(value) + '\n'); }
    function later(callback) { const timer = setTimeout(() => { timers.delete(timer); if (!stopped) callback(); }, delayMs); timers.add(timer); }
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line);
        if (!message.method) {
          const waiter = toolWaiters.get(message.id);
          if (waiter) { toolResponses.push(message); toolWaiters.delete(message.id); waiter(); }
          continue;
        }
        requests.push(message);
        const reply = (result) => emit({ id: message.id, result });
        if (message.method === 'initialize') reply({});
        else if (message.method === 'config/read') reply({ config: { mcp_servers: { discord: { enabled: true, env: { DISCORD_TOKEN: 'hidden-fixture-token' } } } } });
        else if (message.method === 'thread/start') reply({ thread: { id: `thread-${++startedThreads}`, ephemeral: true } });
        else if (message.method === 'mcpServerStatus/list') reply({ data: [{ name: 'discord', tools }] });
        else if (['turn/interrupt', 'thread/unsubscribe', 'thread/compact/start'].includes(message.method)) reply({});
        else if (message.method === 'turn/steer') reply({ turnId: message.params.expectedTurnId });
        else if (message.method === 'account/read') reply({ account: accountType === null ? null : { type: accountType, email: 'private@example.test', planType: 'plus' }, requiresOpenaiAuth: true });
        else if (message.method === 'account/rateLimits/read') reply({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 123456 } } });
        else if (message.method === 'model/list') reply({ data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] });
        else if (message.method === 'turn/start') {
          const turnId = `turn-${++turns}`;
          const threadId = message.params.threadId;
          reply({ turn: { id: turnId, status: 'inProgress' } });
          if (hang) continue;
          const plan = plans?.[turns - 1] || { shouldReply: true, messages: [defaultMessage] };
          const text = JSON.stringify(plan);
          const first = plan.messages[0] ? text.indexOf(JSON.stringify(plan.messages[0])) + JSON.stringify(plan.messages[0]).length : Math.floor(text.length / 2);
          const itemId = `item-${turnId}`;
          const finish = () => later(() => {
            emit({ method: 'item/started', params: { threadId, turnId, item: { id: itemId, type: 'agentMessage', phase: 'final_answer' } } });
            emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: text.slice(0, first) } });
            later(() => {
              emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: text.slice(first) } });
              emit({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { cachedInputTokens: turns > 1 ? 1024 : 0, inputTokens: 2048 } } } });
              completedTurns += 1;
              emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
            });
          });
          for (const event of events) emit({ method: event.method, params: { threadId, turnId, ...event.params } });
          let calls = Promise.resolve();
          for (const [index, call] of toolCalls.entries()) calls = calls.then(() => new Promise((resolve) => {
            const id = `tool-request-${turnId}-${index}`;
            toolWaiters.set(id, resolve);
            emit({ id, method: call.method || 'item/tool/call', params: { threadId, turnId, callId: `call-${index}`, tool: call.tool, arguments: call.arguments || {}, ...call.params } });
          }));
          void calls.then(finish);
        }
      }
      callback();
    } });
    child.kill = () => {
      if (stopped) return true;
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      const finish = () => { child.exitCode = 0; child.emit('close', 0); };
      if (closeDelayMs) setTimeout(finish, closeDelayMs); else queueMicrotask(finish);
      return true;
    };
    return child;
  };

  return { spawnImpl, requests, launches, children, toolResponses, completedTurns: () => completedTurns };
}
