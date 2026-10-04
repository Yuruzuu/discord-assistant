import { directMessageOwnerId } from './target.mjs';
import { createProactiveController } from './controller.mjs';

export function createDaemonControls({ service, configuration, getRuntime, getStatus, jobs, digests }) {
  const controller = createProactiveController(service);
  async function execute(request) {
    if (!request || request.userId !== directMessageOwnerId) throw new Error('Only the owner can control Nova');
    if (request.action === 'help') return request.value;
    if (request.action === 'research' || request.action === 'jobs') {
      if (!configuration.allServers) {
        const response = await controller.control({ accountId: configuration.accountId, allServers: true, ...request });
        return response.result;
      }
      if (request.action === 'research') return jobs.start({ userId: request.userId, guildId: request.guildId, channelId: request.channelId, request: request.value, name: 'Nova research' });
      if (request.operation === 'stop') return jobs.stop(request.id);
      if (request.operation === 'status') return jobs.status(request.id);
      return jobs.list();
    }
    if (request.action === 'digest') {
      if (!configuration.directMessages) {
        const response = await controller.control({ accountId: configuration.accountId, directMessages: true, ...request });
        return response.result;
      }
      if (request.operation === 'add') return digests.add({ ...request.configuration, userId: request.userId });
      if (request.operation === 'remove') return digests.remove({ userId: request.userId, id: request.id });
      if (request.operation === 'run') { void digests.runNow({ userId: request.userId, id: request.id }).catch(() => {}); return { queued: true, id: request.id }; }
      if (request.operation === 'status') return digests.status({ userId: request.userId, id: request.id });
      return digests.list({ userId: request.userId });
    }
    const channelId = request.channelId || configuration.channelId;
    const guildId = request.guildId || configuration.guildId;
    const runtime = await getRuntime(guildId, channelId);
    const result = await runtime.control(request);
    return request.action === 'status' ? { ...result, listener: getStatus() } : result;
  }
  return { execute };
}
