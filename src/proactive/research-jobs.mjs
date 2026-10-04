import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { directMessageOwnerId } from './target.mjs';
import { proactiveRoot } from './state.mjs';

const terminalStates = new Set(['completed', 'failed', 'cancelled']);
const validId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);

export function createResearchJobs({ service, accountId, bot, preferences = {}, createRuntime, root = join(proactiveRoot(), 'research-jobs'), onStatus = () => {} }) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !validId(bot?.id)) throw new Error('Research jobs require a valid account and bot');
  if (typeof createRuntime !== 'function') throw new Error('Provide a scoped research conversation factory');
  const client = service.accountById(accountId).client;
  const jobs = new Map();
  let closed = false;
  const pendingStarts = new Set();
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const filename of await readdir(root)) {
      if (!filename.startsWith(`${accountId}-`) || !filename.endsWith('.json')) continue;
      const saved = JSON.parse(await readFile(join(root, filename), 'utf8'));
      if (saved.accountId !== accountId || typeof saved.id !== 'string' || !/^[a-f0-9-]{36}$/.test(saved.id) || !validId(saved.guildId) || !validId(saved.channelId)) continue;
      const job = { ...saved, runtime: null, writes: Promise.resolve() };
      if (!terminalStates.has(job.state)) { job.state = 'failed'; job.error = 'The previous research process stopped. Start a new job explicitly to continue.'; job.finishedAt = Date.now(); }
      jobs.set(job.id, job);
    }
  })();

  function snapshot(job) {
    if (!job) return null;
    return { id: job.id, accountId, guildId: job.guildId, channelId: job.channelId, threadId: job.threadId || null, introMessageId: job.introMessageId || null,
      state: job.state, createdAt: job.createdAt, finishedAt: job.finishedAt || null, error: job.error || null,
      threadUrl: job.threadId ? `https://discord.com/channels/${job.guildId}/${job.threadId}` : null };
  }

  function persist(job) {
    const value = snapshot(job);
    const filename = join(root, `${accountId}-${job.id}.json`);
    job.writes = job.writes.catch(() => {}).then(async () => {
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await rename(temporary, filename);
      } finally { await unlink(temporary).catch(() => {}); }
    });
    job.writes.catch(() => {});
    onStatus(value);
    return job.writes;
  }

  async function closeRuntime(job) {
    if (!job.runtime || job.runtimeClosed) return;
    job.runtimeClosed = true;
    await job.runtime.close();
  }

  function observe(job, value) {
    if (terminalStates.has(job.state) || !job.submitted) return;
    const previousState = job.state;
    const statistics = value?.statistics || value || job.runtime?.status().statistics;
    if (!statistics) return;
    if ((statistics.errors || 0) > (job.baseline?.errors || 0)) {
      job.state = 'failed';
      job.error = 'Research failed. Check Nova status for the conversation error.';
      job.finishedAt = Date.now();
    } else if (statistics.generating) { job.hadWork = true; job.state = 'running'; }
    else if (statistics.queued > 0) { job.hadWork = true; job.state = 'queued'; }
    else if (job.hadWork) { job.state = 'completed'; job.finishedAt = Date.now(); }
    else return;
    if (job.state !== previousState) void persist(job);
  }

  async function begin({ guildId, channelId, request, name = 'Nova research', userId, existingThread } = {}) {
    if (userId !== directMessageOwnerId) throw new Error('Only the owner can start research jobs');
    if (closed) throw new Error('Research jobs are stopped');
    if (!validId(guildId) || !validId(channelId)) throw new Error('Choose a valid server and source channel');
    if (typeof request !== 'string' || !request.trim() || request.length > 16000) throw new Error('Provide a research request of 1 to 16000 characters');
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Thread names require 1 to 100 characters');
    await ready;
    if (closed) throw new Error('Research jobs are stopped');
    const source = await client.getChannel(channelId);
    if (source.guild_id !== guildId || source.type !== 0) throw new Error('Research jobs require an accessible text channel in the selected server');
    let thread;
    if (existingThread) {
      if (!validId(existingThread)) throw new Error('Provide a valid existing thread ID');
      thread = await client.getChannel(existingThread);
      if (thread.guild_id !== guildId || thread.parent_id !== channelId || thread.type !== 11 || thread.thread_metadata?.archived) throw new Error('The existing thread must be an active public thread of the selected channel');
    }
    if (thread && [...jobs.values()].some((job) => job.threadId === thread.id && !terminalStates.has(job.state))) throw new Error('This thread already has an active research job');
    const job = { id: randomUUID(), guildId, channelId, threadId: thread?.id, state: 'queued', createdAt: Date.now(), runtime: null, writes: Promise.resolve() };
    jobs.set(job.id, job);
    await persist(job);
    try {
      if (closed) throw new Error('Research jobs are stopped');
      thread ||= await client.createThread(channelId, { name: name.trim(), type: 11, auto_archive_duration: 1440 });
      if (!validId(thread.id)) throw new Error('Discord did not confirm the new thread ID');
      job.threadId = thread.id;
      await persist(job);
      if (closed) throw new Error('Research jobs are stopped');
      const intro = await client.sendMessage(thread.id, {
        content: `Research requested by the owner:\n${request.slice(0, 1700)}${request.length > 1700 ? '\n(The full request is supplied to this research conversation.)' : ''}`,
        allowed_mentions: { parse: [] }, nonce: job.id.replaceAll('-', '').slice(0, 24), enforce_nonce: true,
      });
      if (!validId(intro.id)) throw new Error('Discord did not confirm the research introduction');
      job.introMessageId = intro.id;
      await persist(job);
      if (closed) throw new Error('Research jobs are stopped');
      job.runtime = await createRuntime({ guildId, channelId: thread.id, configuration: { ...preferences, accountId, guildId, channelId: thread.id, directMessages: false, allServers: false, mode: 'mentions' }, onStatus: (value) => observe(job, value) });
      if (closed) { await closeRuntime(job); throw new Error('Research jobs are stopped'); }
      job.baseline = { ...job.runtime.status().statistics };
      job.submitted = true;
      const accepted = await job.runtime.receive({ id: intro.id, guild_id: guildId, channel_id: thread.id, content: request,
        author: { id: directMessageOwnerId, bot: false }, mentions: [{ id: bot.id }],
        hostProvenance: { type: 'owner_research_job', ownerUserId: directMessageOwnerId, sourceChannelId: channelId, introMessageId: intro.id },
      });
      if (!accepted) throw new Error('The research conversation did not accept the owner request');
      observe(job, job.runtime.status());
      return snapshot(job);
    } catch (error) {
      job.state = closed ? 'cancelled' : 'failed';
      job.error = closed ? null : 'Research could not start. Any unconfirmed Discord operation was not retried.';
      job.finishedAt = Date.now();
      await closeRuntime(job).catch(() => {});
      await persist(job);
      const failure = new Error(job.error || 'Research jobs are stopped', { cause: error });
      failure.job = snapshot(job);
      throw failure;
    }
  }

  function start(options) {
    const operation = begin(options);
    pendingStarts.add(operation);
    operation.finally(() => pendingStarts.delete(operation)).catch(() => {});
    return operation;
  }

  async function stop(id) {
    await ready;
    const job = jobs.get(id);
    if (!job) throw new Error('Unknown research job');
    if (!terminalStates.has(job.state)) { job.state = 'cancelled'; job.finishedAt = Date.now(); }
    await closeRuntime(job);
    await persist(job);
    return snapshot(job);
  }

  async function close() {
    closed = true;
    await ready;
    await Promise.allSettled([...pendingStarts]);
    await Promise.allSettled([...jobs.values()].map(async (job) => {
      if (!terminalStates.has(job.state)) { job.state = 'cancelled'; job.finishedAt = Date.now(); }
      await closeRuntime(job);
      await persist(job);
    }));
  }

  return { start, list: () => [...jobs.values()].map((job) => { observe(job); return snapshot(job); }), status: (id) => { const job = jobs.get(id); if (job) observe(job); return snapshot(job); }, stop, close, ready: () => ready };
}
