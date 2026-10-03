import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { DiscordService } from '../src/service.mjs';

const guildA = '100000000000000001';
const guildB = '100000000000000002';
const categoryB = '150000000000000002';
const forumB = '200000000000000001';
const channelB = '200000000000000002';
const messageB = '300000000000000002';
const threadB = '400000000000000002';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function createFetch() {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('image-data'),
  ]);
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'cdn.discordapp.com') {
      return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    }
    const token = options.headers?.Authorization?.replace('Bot ', '');
    const path = url.pathname;
    const guild = token === 'token-a' ? { id: guildA, name: 'longlenai' } : { id: guildB, name: 'longlenai-dev' };
    if (path === '/api/v10/users/@me') return json({ id: token === 'token-a' ? '500000000000000001' : '500000000000000002', username: token });
    if (path === '/api/v10/users/@me/guilds') return json([guild]);
    if (path === `/api/v10/guilds/${guild.id}`) return json(guild);
    if (path === `/api/v10/guilds/${guild.id}/channels`) {
      return json(guild.id === guildB ? [
        { id: categoryB, guild_id: guildB, name: 'Support', type: 4 },
        { id: forumB, guild_id: guildB, parent_id: categoryB, name: 'bug-reports', type: 15 },
        { id: channelB, guild_id: guildB, parent_id: categoryB, name: 'general', type: 0 },
      ] : []);
    }
    if (path === `/api/v10/guilds/${guild.id}/threads/active`) {
      return json(guild.id === guildB ? {
        threads: [{ id: threadB, guild_id: guildB, parent_id: forumB, name: 'Crash report', type: 11, last_message_id: messageB, thread_metadata: { archived: false } }],
      } : { threads: [] });
    }
    if (path === `/api/v10/channels/${channelB}` && token === 'token-b') {
      return json({ id: channelB, guild_id: guildB, parent_id: categoryB, name: 'general', type: 0 });
    }
    if (path === `/api/v10/channels/${channelB}/messages/${messageB}` && token === 'token-b') {
      return json({
        id: messageB,
        channel_id: channelB,
        author: { id: '600000000000000001', username: 'reporter' },
        timestamp: '2026-09-01T00:00:00.000Z',
        content: 'The app crashes',
        attachments: [{ id: '700000000000000001', filename: 'bug.png', content_type: 'image/png', size: 10, url: 'https://cdn.discordapp.com/attachments/1/2/bug.png' }],
      });
    }
    return json({ message: 'Missing Access', code: 50001 }, 403);
  };
}

function createArchivedForumFetch(paths) {
  return async (input, options = {}) => {
    const url = new URL(input);
    const path = `${url.pathname}${url.search}`;
    paths.push(path);
    const token = options.headers?.Authorization?.replace('Bot ', '');
    if (url.pathname === '/api/v10/users/@me') return json({ id: '500000000000000002', username: token });
    if (url.pathname === '/api/v10/users/@me/guilds') return json([{ id: guildB, name: 'longlenai-dev' }]);
    if (url.pathname === `/api/v10/guilds/${guildB}`) return json({ id: guildB, name: 'longlenai-dev' });
    if (url.pathname === `/api/v10/guilds/${guildB}/channels`) {
      return json([{ id: forumB, guild_id: guildB, parent_id: categoryB, name: 'bug-reports', type: 15 }]);
    }
    if (url.pathname === `/api/v10/guilds/${guildB}/threads/active`) return json({ threads: [] });
    if (url.pathname === `/api/v10/channels/${forumB}/threads/archived/public`) {
      return json({
        threads: [{ id: threadB, guild_id: guildB, parent_id: forumB, name: 'Archived crash', type: 11, thread_metadata: { archived: true } }],
        has_more: false,
      });
    }
    return json({ message: 'Unexpected route' }, 500);
  };
}

function service() {
  return new DiscordService({
    accounts: [
      { id: 'primary', token: 'token-a', priority: 100, expectedGuildIds: [] },
      { id: 'dev', token: 'token-b', priority: 50, expectedGuildIds: [] },
    ],
    imageLimits: { maxBytesPerImage: 1024, maxImagesPerCall: 4, maxTotalImageBytes: 4096 },
    fetchImpl: createFetch(),
    sleep: async () => {},
    maxRetries: 0,
  });
}

test('discovers multiple servers and routes a message URL to the right bot', async () => {
  const discord = service();
  const discovered = await discord.listServers();
  assert.deepEqual(discovered.servers.map((guild) => guild.name), ['longlenai', 'longlenai-dev']);

  const result = await discord.read({
    url: `https://discord.com/channels/${guildB}/${channelB}/${messageB}`,
    includeImages: false,
  });
  assert.equal(result.structured.accountId, 'dev');
  assert.equal(result.structured.messages[0].content, 'The app crashes');
  assert.equal(result.structured.messages[0].url, `https://discord.com/channels/${guildB}/${channelB}/${messageB}`);
});

test('invalidates a cached channel route and falls back to another bot', async () => {
  let primaryRevoked = false;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const token = options.headers?.Authorization?.replace('Bot ', '');
    if (url.pathname === '/api/v10/users/@me') return json({ id: token === 'token-a' ? '500000000000000001' : '500000000000000002', username: token });
    if (url.pathname === '/api/v10/users/@me/guilds') return json([{ id: guildB, name: 'longlenai-dev' }]);
    if (url.pathname === `/api/v10/channels/${channelB}`) {
      if (token === 'token-a' && primaryRevoked) return json({ message: 'Missing Access' }, 403);
      return json({ id: channelB, guild_id: guildB, name: 'general', type: 0 });
    }
    return json({ message: 'Unexpected route' }, 500);
  };
  const discord = new DiscordService({
    accounts: [
      { id: 'primary', token: 'token-a', priority: 100, expectedGuildIds: [] },
      { id: 'backup', token: 'token-b', priority: 50, expectedGuildIds: [] },
    ],
    fetchImpl,
    sleep: async () => {},
    maxRetries: 0,
  });

  assert.equal((await discord.resolveChannel(channelB, guildB)).account.id, 'primary');
  primaryRevoked = true;
  assert.equal((await discord.resolveChannel(channelB, guildB)).account.id, 'backup');
});

test('returns Discord image blocks from message attachments', async () => {
  const result = await service().read({
    url: `https://discord.com/channels/${guildB}/${channelB}/${messageB}`,
    includeImages: true,
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].type, 'image');
  assert.equal(Buffer.from(result.images[0].data, 'base64').subarray(8).toString(), 'image-data');
});

test('fetches a direct Discord CDN image URL with no bot authorization requirement', async () => {
  const result = await service().fetchAttachment({
    attachmentUrl: 'https://cdn.discordapp.com/attachments/1/2/bug.png',
  });
  assert.equal(result.structured.accountId, null);
  assert.equal(result.structured.attachment.source, 'direct-url');
  assert.equal(result.image.mimeType, 'image/png');
  await assert.rejects(
    () => service().fetchAttachment({
      messageUrl: `https://discord.com/channels/${guildB}/${channelB}/${messageB}`,
      attachmentUrl: 'https://cdn.discordapp.com/attachments/1/2/bug.png',
    }),
    /exactly one/,
  );
});

test('lists active forum threads as tickets', async () => {
  const result = await service().listTickets({
    guildId: guildB,
    parentChannelIds: [forumB],
    includeArchived: false,
  });
  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0].id, threadB);
  assert.equal(result.tickets[0].typeName, 'PUBLIC_THREAD');
});

test('uses only the public archive route for forum ticket parents', async () => {
  const paths = [];
  const discord = new DiscordService({
    accounts: [{ id: 'reader', token: 'token-b', priority: 1, expectedGuildIds: [] }],
    fetchImpl: createArchivedForumFetch(paths),
    sleep: async () => {},
    maxRetries: 0,
  });
  const result = await discord.listTickets({ guildId: guildB, parentChannelIds: [forumB] });
  assert.equal(result.tickets[0].name, 'Archived crash');
  assert.equal(paths.some((path) => path.includes('/users/@me/threads/archived/private')), false);
});

test('coalesces concurrent discovery and still honors an explicit refresh', async () => {
  const discord = service();
  const requests = [];
  for (const account of discord.accounts) {
    const original = account.client.fetch;
    account.client.fetch = async (input, options) => {
      requests.push(new URL(input).pathname);
      await setTimeout(2);
      return original(input, options);
    };
  }
  const first = await Promise.all([discord.listServers(), discord.listServers()]);
  assert.deepEqual(first[0], first[1]);
  assert.equal(requests.length, 4);

  await discord.listServers();
  assert.equal(requests.length, 4);
  await Promise.all([discord.listServers({ refresh: true }), discord.listServers({ refresh: true })]);
  assert.equal(requests.length, 8);
});

test('fetches guild metadata once per channel listing and refreshes it on the next call', async () => {
  const discord = service();
  let guildRequests = 0;
  const client = discord.accounts[1].client;
  const original = client.fetch;
  client.fetch = async (input, options) => {
    if (new URL(input).pathname === `/api/v10/guilds/${guildB}`) guildRequests += 1;
    return original(input, options);
  };
  await discord.listChannels({ guildId: guildB });
  assert.equal(guildRequests, 1);
  await discord.listChannels({ guildId: guildB });
  assert.equal(guildRequests, 2);
});

test('only scans archive parents in the requested ticket category', async () => {
  const paths = [];
  const original = createArchivedForumFetch(paths);
  const discord = new DiscordService({
    accounts: [{ id: 'reader', token: 'token-b' }],
    maxRetries: 0,
    fetchImpl: async (input, options) => {
      if (new URL(input).pathname === `/api/v10/guilds/${guildB}/channels`) {
        return json([
          { id: forumB, guild_id: guildB, parent_id: categoryB, name: 'bug-reports', type: 15 },
          { id: channelB, guild_id: guildB, parent_id: '150000000000000003', name: 'unrelated', type: 0 },
        ]);
      }
      return original(input, options);
    },
  });
  const result = await discord.listTickets({ guildId: guildB, categoryIds: [categoryB] });

  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0].id, threadB);
  assert.equal(paths.filter((path) => path.includes('/threads/archived/')).length, 1);
  assert.equal(paths.some((path) => path.includes(`/channels/${channelB}/`)), false);
});

test('invalid ticket filters fail before any Discord requests', async () => {
  let requests = 0;
  const discord = new DiscordService({
    accounts: [{ id: 'reader', token: 'token-b' }],
    fetchImpl: async () => { requests += 1; throw new Error('Unexpected request'); },
  });
  await assert.rejects(() => discord.listTickets({ guildId: guildB, namePattern: '[' }), /valid regular expression/);
  await assert.rejects(() => discord.listTickets({ guildId: guildB, updatedAfter: 'invalid' }), /ISO-8601/);

  assert.equal(requests, 0);
});

test('archive concurrency preserves channel and warning order with partial access', async () => {
  const parents = [0, 1, 2].map((index) => ({
    id: String(200000000000000010n + BigInt(index)), guild_id: guildB, name: `parent-${index}`, type: 0,
  }));
  let active = 0;
  let maximumActive = 0;
  const original = createFetch();
  const discord = new DiscordService({
    accounts: [{ id: 'reader', token: 'token-b' }],
    requestConcurrency: 2,
    maxRetries: 0,
    fetchImpl: async (input, options) => {
      const path = new URL(input).pathname;
      if (path === `/api/v10/guilds/${guildB}/channels`) return json(parents);
      if (path === `/api/v10/guilds/${guildB}/threads/active`) return json({ threads: [] });
      if (!path.includes('/threads/archived/')) return original(input, options);

      const parentId = path.split('/')[4];
      const isPrivate = path.endsWith('/private');
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await setTimeout(parentId === parents[0].id ? 10 : 2);
      active -= 1;
      if (parentId === parents[1].id && isPrivate) return json({ message: 'Missing Access' }, 403);
      return json({
        threads: [{
          id: String(BigInt(parentId) + (isPrivate ? 200n : 100n)),
          guild_id: guildB,
          parent_id: parentId,
          type: 11,
          name: 'Ticket',
          thread_metadata: { archive_timestamp: '2026-01-01T00:00:00.000Z' },
        }],
        has_more: parentId === parents[0].id && !isPrivate,
      });
    },
  });
  const result = await discord.listChannels({ guildId: guildB, includeArchivedThreads: true, maxArchivedPerParent: 1 });
  const expectedThreadIds = parents.flatMap((parent, index) => [100n, 200n]
    .filter((offset) => !(index === 1 && offset === 200n))
    .map((offset) => String(BigInt(parent.id) + offset)));

  assert.equal(maximumActive, 2);
  assert.deepEqual(result.channels.map((channel) => channel.id), [...parents.map((parent) => parent.id), ...expectedThreadIds]);
  assert.deepEqual(result.warnings.map((warning) => warning.channelId), [parents[0].id, parents[1].id]);
  assert.equal(result.warnings[1].error.status, 403);
});

test('reuses duplicate images within a read while preserving output and the total byte budget', async () => {
  const discord = service();
  const account = discord.accounts[1];
  const original = account.client.fetch;
  let imageRequests = 0;
  account.client.fetch = async (input, options) => {
    if (new URL(input).hostname === 'cdn.discordapp.com') imageRequests += 1;
    return original(input, options);
  };
  const messages = [0, 1].map((index) => ({
    id: String(300000000000000001n + BigInt(index)),
    attachments: [{ filename: 'same.png', content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/bug.png' }],
  }));
  const result = await discord.imageContent(account, messages);
  assert.equal(result.content.length, 2);
  assert.deepEqual(result.content[0], result.content[1]);
  assert.equal(imageRequests, 1);

  discord.imageLimits.maxTotalImageBytes = 20;
  const limited = await discord.imageContent(account, messages);
  assert.equal(limited.content.length, 1);
  assert.equal(limited.warnings.length, 1);
  assert.match(limited.warnings[0].error, /image limit/);
  assert.equal(imageRequests, 2);
});
