import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordService } from '../src/service.mjs';
import { sendMessage, sendMessageBatch } from '../src/messaging.mjs';
import { getUserInfo } from '../src/users.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const userId = '300000000000000001';
const messageId = '400000000000000001';

function fixture({ failAt } = {}) {
  const sends = [];
  const requests = [];
  const service = new DiscordService({
    accounts: [{ id: 'reader', token: 'mock-token' }], maxRetries: 0,
    fetchImpl: async (input, options) => {
      const path = new URL(input).pathname.replace('/api/v10', '');
      requests.push(path);
      let value;
      let status = 200;
      if (options.method === 'POST') {
        const payload = JSON.parse(options.body);
        sends.push(payload);
        if (sends.length === failAt) { status = 403; value = { message: 'Missing Permissions' }; }
        else value = { id: String(500000000000000000n + BigInt(sends.length)), channel_id: channelId, content: payload.content || '', message_reference: payload.message_reference };
      } else if (path === '/users/@me') value = { id: userId, username: 'Nova', bot: true };
      else if (path === '/users/@me/guilds') value = [{ id: guildId, name: 'Example' }];
      else if (path === `/guilds/${guildId}`) value = { id: guildId, name: 'Example' };
      else if (path === `/channels/${channelId}`) value = { id: channelId, guild_id: guildId, type: 0 };
      else if (path === `/users/${userId}`) value = { id: userId, username: 'person', global_name: 'Person', avatar: 'a_avatar', bot: false, public_flags: 64, email: 'private@example.com' };
      else if (path === `/guilds/${guildId}/members/${userId}`) value = { user: { id: userId }, nick: 'Nickname', roles: ['600000000000000001'], joined_at: '2026-01-01T00:00:00Z', avatar: 'server-avatar' };
      else if (path === `/guilds/${guildId}/roles`) value = [{ id: '600000000000000001', name: 'Developer', color: 1234 }];
      else throw new Error(`Unexpected route ${path}`);
      return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    },
  });

  return { service, sends, requests };
}

test('native replies keep the reply relationship without mentioning the author', async () => {
  const { service, sends } = fixture();
  const result = await sendMessage(service, { channelId, content: 'Yep!', replyToMessageId: messageId });

  assert.deepEqual(sends[0].message_reference, { message_id: messageId, channel_id: channelId, fail_if_not_exists: true });
  assert.deepEqual(sends[0].allowed_mentions, { parse: [], replied_user: false });
  assert.equal(result.message.replyTo, messageId);
});

test('reply notification can be requested separately from other mentions', async () => {
  const { service, sends } = fixture();
  await sendMessage(service, { channelId, content: 'Yep!', replyToMessageId: messageId, mentionRepliedUser: true });
  assert.deepEqual(sends[0].allowed_mentions, { parse: [], replied_user: true });
});

test('GIF-only sends and text plus GIF URLs are supported', async () => {
  const { service, sends } = fixture();
  const gifUrl = 'https://media.tenor.com/example/hello.gif';
  await sendMessage(service, { channelId, gifUrl });
  await sendMessage(service, { channelId, content: 'lmao', gifUrl });
  assert.equal(sends[0].content, gifUrl);
  assert.equal(sends[1].content, `lmao\n${gifUrl}`);
  await assert.rejects(() => sendMessage(service, { channelId, gifUrl: 'http://example.com/file.gif' }), /HTTPS/);
  assert.equal(sends.length, 2);
});

test('message batches keep order and reference the original message only once', async () => {
  const { service, sends } = fixture();
  const waits = [];
  const result = await sendMessageBatch(service, { channelId, messages: [{ content: 'ohhh' }, { content: 'I see it now' }], replyToMessageId: messageId, batchId: 'stable-batch' }, { sleep: async (delay) => { waits.push(delay); } });
  assert.deepEqual(sends.map((payload) => payload.content), ['ohhh', 'I see it now']);
  assert.equal(sends[0].message_reference.message_id, messageId);
  assert.equal(sends[1].message_reference, undefined);
  assert.deepEqual(sends.map((payload) => payload.nonce), ['stable-batch:0', 'stable-batch:1']);
  assert.deepEqual(waits, [650]);
  assert.equal(result.sentMessages.length, 2);
});

test('invalid later batch content fails before any messages are sent', async () => {
  const { service, sends } = fixture();
  await assert.rejects(() => sendMessageBatch(service, { channelId, messages: [{ content: 'first' }, { content: 'x'.repeat(2001) }] }), /2000/);
  assert.equal(sends.length, 0);
});

test('partial batch failures report receipts and stop the remaining sends', async () => {
  const { service, sends } = fixture({ failAt: 2 });
  await assert.rejects(() => sendMessageBatch(service, { channelId, intervalMs: 0, messages: [{ content: 'first' }, { content: 'second' }, { content: 'third' }] }), (error) => {
    assert.equal(error.failedMessageIndex, 1);
    assert.equal(error.sentMessages.length, 1);
    assert.equal(error.sentMessages[0].message.content, 'first');
    return true;
  });
  assert.equal(sends.length, 2);
});

test('stopping a batch prevents subsequent messages', async () => {
  const { service, sends } = fixture();
  const cancellation = new AbortController();
  await assert.rejects(() => sendMessageBatch(service, { channelId, messages: [{ content: 'first' }, { content: 'second' }] }, {
    signal: cancellation.signal,
    sleep: async () => { cancellation.abort(); },
  }), /abort/i);
  assert.equal(sends.length, 1);
});

test('user info includes profile and server roles while excluding private fields', async () => {
  const { service } = fixture();
  const result = await getUserInfo(service, { userId, guildId });
  assert.equal(result.user.displayName, 'Person');
  assert.match(result.user.avatarUrl, /avatars\/300000000000000001\/a_avatar\.gif/);
  assert.equal(result.member.nickname, 'Nickname');
  assert.deepEqual(result.member.roles, [{ id: '600000000000000001', name: 'Developer', color: 1234 }]);
  assert.match(result.member.serverAvatarUrl, /guilds\/100000000000000001\/users\/300000000000000001\/avatars\/server-avatar\.png/);
  assert.ok(!('email' in result.user));
  assert.ok(!('presence' in result.user));
});

test('public user lookup without a guild does not fetch member data', async () => {
  const { service, requests } = fixture();
  const result = await getUserInfo(service, { userId });
  assert.equal(result.member, null);
  assert.deepEqual(requests, [`/users/${userId}`]);
});
