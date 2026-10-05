import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createOwnerActions, formatOwnerAction } from './owner-actions.mjs';
import { createScheduleManager } from './schedules.mjs';
import { createTaskHandoffs } from './task-handoffs.mjs';
import { createProgressReporter } from './progress.mjs';
import { sanitizeCommand } from './command-trace.mjs';
import { directMessageOwnerId } from './target.mjs';
import { proactiveRoot } from './state.mjs';
import { markSendStatus } from '../messaging.mjs';

const nonceFor = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export async function createOwnerCapabilities({ service, accountId, channelId, settings, connectedApps, actionComponents, root, onError = () => {}, handoffFactory = createTaskHandoffs }) {
  const client = service.accountById(accountId).client;
  const actor = { userId: directMessageOwnerId, channelId, guildId: null, explicitOwnerAction: true };
  const reporters = new Map();
  let schedules;
  let handoffs;
  let actions;
  async function send(content, identifier, { components = [], files, signal } = {}) {
    const payload = { content, components, allowed_mentions: { parse: [] }, nonce: nonceFor(identifier), enforce_nonce: true };
    try { return files ? await client.sendMessageFiles(channelId, payload, files, { signal }) : await client.sendMessage(channelId, payload, { signal }); }
    catch (error) { throw markSendStatus(error); }
  }
  function reporter(taskId) {
    if (!reporters.has(taskId)) reporters.set(taskId, createProgressReporter({ intervalMs: 1500, maxMessages: 1,
      send: (content) => send(content, `task-progress:${taskId}`),
      edit: (receipt, content, signal, extra = {}) => client.editMessage(channelId, receipt.id, { content, allowed_mentions: { parse: [] }, ...extra }, { signal }),
      onError,
    }));
    return reporters.get(taskId);
  }
  try {
    if (settings.reminders !== false) {
      schedules = createScheduleManager({ service, accountId, apps: connectedApps, timeZone: settings.timeZone || 'Asia/Manila', ...(root ? { root: join(root, 'schedules') } : {}),
        deliver: async (payload, signal) => {
          const message = await send(payload.content, payload.operationId, { signal });
          return { confirmed: true, message: { id: message.id, channelId } };
        },
      });
      await schedules.ready;
    }
    if (settings.handoffs !== false) {
      handoffs = handoffFactory({ root: join(root || proactiveRoot(), 'task-handoffs', `${accountId}-${channelId}`),
        onError,
        onProgress: async (event) => {
          if (event.channelId !== channelId) return;
          const stage = ['completed', 'succeeded'].includes(event.state) ? 'completed' : ['failed', 'interrupted', 'cancelled'].includes(event.state) ? 'failed' : 'started';
          await reporter(event.taskId).receive({ stage, toolName: 'task_command', callId: event.itemId, arguments: { command: sanitizeCommand(event.command) } });
        },
        onApproval: async (approval) => {
          if (approval.channelId !== channelId) return;
          const choices = approval.decisions.filter((decision) => ['accept', 'decline', 'cancel'].includes(decision)).map((decision) => ({ action: 'task-approval', label: decision === 'accept' ? 'Approve once' : 'Decline', decision, taskId: approval.taskId, requestId: approval.requestId }));
          await send(`Coding task ${approval.taskId} needs your approval:\n\`\`\`\n${sanitizeCommand(approval.command)}\n\`\`\``, `task-approval:${approval.taskId}:${approval.requestId}`, { components: actionComponents?.(choices) || [] });
        },
        onComplete: async (task) => {
          if (task.channelId !== channelId) return;
          await reporters.get(task.id)?.finish({ failed: task.state === 'failed', cancelled: ['interrupted', 'cancelled'].includes(task.state) });
          reporters.delete(task.id);
          await send(`Coding task ${task.id}: ${task.state}.${task.latestReply ? `\n\n${task.latestReply}` : ''}`, `task-complete:${task.id}:${task.updatedAt}`);
        },
      });
      await handoffs.ready();
    }
    actions = createOwnerActions({ accountId, channelId, ...(root ? { root: join(root, 'approvals') } : {}),
      execute: async (request, { signal }) => {
        if (request.kind === 'app') {
          if (!connectedApps || settings.appActions === false) throw Object.assign(new Error('App actions are disabled'), { approvalRejected: true });
          return connectedApps.callApproved(request, signal);
        }
        if (request.kind === 'reminder' || request.kind === 'alert') {
          if (!schedules) throw Object.assign(new Error('Schedules are disabled'), { approvalRejected: true });
          return request.kind === 'reminder' ? schedules.addReminder({ ...request.configuration, userId: directMessageOwnerId }) : schedules.addAlert({ ...request.configuration, userId: directMessageOwnerId });
        }
        if (request.kind === 'handoff') {
          if (!handoffs) throw Object.assign(new Error('Task handoffs are disabled'), { approvalRejected: true });
          return handoffs.start({ ...request.configuration, ...actor });
        }
        throw Object.assign(new Error('Unsupported owner action'), { approvalRejected: true });
      },
      deliver: async (action, signal) => {
        const text = JSON.stringify(action.request, null, 2);
        const components = actionComponents?.([{ action: 'approval', label: 'Approve once', decision: 'approve', id: action.id }, { action: 'approval', label: 'Decline', decision: 'decline', id: action.id }]) || [];
        await send(formatOwnerAction(action), `action-approval:${action.id}`, { components, signal, ...(text.length > 1500 ? { files: [{ name: `proposal-${action.id}.json`, content: text }] } : {}) });
      },
    });
    await actions.ready;
  } catch (error) { await actions?.close(); await schedules?.close(); await handoffs?.close(); throw error; }

  async function control(request) {
    if (request.userId !== directMessageOwnerId || (request.channelId && request.channelId !== channelId) || request.guildId) throw new Error('These controls belong to the owner DM');
    if (request.action === 'approval') return actions.decide({ ...request, channelId });
    if (request.action === 'approvals') return actions.list({ userId: request.userId });
    if (request.action === 'task-approval') return handoffs.respondApproval(request.taskId, request.requestId, request.decision, actor);
    if (['reminder', 'alert'].includes(request.action)) {
      if (!schedules) throw new Error('Reminders and alerts are disabled');
      const args = { ...request.configuration, userId: request.userId, ...(request.id ? { id: request.id } : {}) };
      if (request.operation === 'add') return request.action === 'reminder' ? schedules.addReminder(args) : schedules.addAlert(args);
      if (request.operation === 'remove' || request.operation === 'stop') return schedules.remove(args);
      if (request.operation === 'update') return schedules.update(args);
      if (request.operation === 'run') return schedules.runNow(args);
      if (request.operation === 'resolve') return schedules.resolveOutcome(args);
      if (request.operation === 'status') return schedules.status(args);
      return schedules.list(args);
    }
    if (['handoff', 'tasks'].includes(request.action)) {
      if (!handoffs) throw new Error('Task handoffs are disabled');
      if (request.operation === 'catalog') return handoffs.catalog(actor);
      if (request.operation === 'start' || request.operation === 'add') return handoffs.start({ ...request.configuration, ...actor });
      if (request.operation === 'status') return handoffs.status(request.id, actor);
      if (request.operation === 'stop') return handoffs.stop(request.id, actor);
      if (request.operation === 'steer') return handoffs.steer(request.configuration.id, request.configuration.request, actor);
      return handoffs.list(actor);
    }
    return null;
  }
  return { actions, schedules, handoffs, control, close: async () => { for (const progress of reporters.values()) progress.close(); await schedules?.close(); await handoffs?.close(); await actions.close(); } };
}
