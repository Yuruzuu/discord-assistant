import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DiscordService } from '../src/service.mjs';
import { createDiscordMcpServer } from '../src/server.mjs';
import { sendMessage } from '../src/messaging.mjs';
import { discordEmbeds, linkButtonRows } from '../src/rich-messages.mjs';
import { validateReplyPlan } from '../src/proactive/reply-validation.mjs';
import { createReplySender } from '../src/proactive/reply-sender.mjs';
import { createReplyStream } from '../src/proactive/reply-stream.mjs';
import { replySchema } from '../src/proactive/reply-style.mjs';

const guildId = '100000000000000001';
const channelId = '200000000000000001';
const emojiMarkup = '<:wave:400000000000000001>';
const novaEmbed = { title: 'Patch notes', description: `Fixes ${emojiMarkup}`, url: 'https://example.com/notes', color: '#5865F2', fields: [{ name: 'Fate', value: 'Buffed', inline: true }], imageUrl: null, thumbnailUrl: 'https://cdn.example.com/icon.png', footer: 'v2.1' };

function fixture() {
  const requests = [];
  const service = new DiscordService({
    accounts: [{ id: 'reader', token: 'mock-token' }],
    fetchImpl: async (input, options) => {
      const path = new URL(input).pathname.replace('/api/v10', '');
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({ path, method: options.method, payload });
      const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === `/channels/${channelId}`) return json({ id: channelId, guild_id: guildId, name: 'general', type: 0 });
      if (path === `/channels/${channelId}/messages`) return json({ id: '700000000000000001', channel_id: channelId, content: payload.content || '', embeds: payload.embeds, author: { id: '500000000000000001', username: 'Nova', bot: true } });
      throw new Error(`Unexpected route: ${path}`);
    },
  });
  return { service, sends: () => requests.filter((request) => request.method === 'POST') };
}

test('embeds convert to Discord payloads with HTTPS-only links and Discord limits', () => {
  assert.deepEqual(discordEmbeds([novaEmbed]), [{
    title: 'Patch notes', description: `Fixes ${emojiMarkup}`, url: 'https://example.com/notes', color: 0x5865F2,
    fields: [{ name: 'Fate', value: 'Buffed', inline: true }], thumbnail: { url: 'https://cdn.example.com/icon.png' }, footer: { text: 'v2.1' },
  }]);
  assert.deepEqual(discordEmbeds([{ description: 'x', author: { name: 'Nova', iconUrl: 'https://cdn.example.com/a.png' }, footer: { text: 'f', iconUrl: 'https://cdn.example.com/f.png' }, timestamp: '2026-10-14T00:00:00Z', color: 255 }])[0],
    { description: 'x', author: { name: 'Nova', icon_url: 'https://cdn.example.com/a.png' }, footer: { text: 'f', icon_url: 'https://cdn.example.com/f.png' }, timestamp: '2026-10-14T00:00:00.000Z', color: 255 });
  assert.throws(() => discordEmbeds([{ title: 'x', imageUrl: 'http://example.com/a.png' }]), /HTTPS/);
  assert.throws(() => discordEmbeds([{ title: 'x', url: 'https://user:pass@example.com' }]), /without credentials/);
  assert.throws(() => discordEmbeds([{ url: 'https://example.com', color: '#000000' }]), /needs a title/);
  assert.throws(() => discordEmbeds([{ title: 'x', timestamp: 'yesterday' }]), /ISO 8601/);
  assert.throws(() => discordEmbeds(Array.from({ length: 2 }, () => ({ description: 'a'.repeat(4000) }))), /6000/);
  assert.throws(() => discordEmbeds(Array.from({ length: 11 }, () => ({ title: 'x' }))), /at most 10/);
  assert.throws(() => discordEmbeds([{ title: 'x', script: 'nope' }]));
});

test('link buttons become rows of five and never carry custom interaction IDs', () => {
  const rows = linkButtonRows(Array.from({ length: 7 }, (_, index) => ({ label: `Link ${index}`, url: `https://example.com/${index}` })));
  assert.deepEqual(rows.map((row) => row.components.length), [5, 2]);
  assert.ok(rows.flatMap((row) => row.components).every((button) => button.type === 2 && button.style === 5 && !('custom_id' in button)));
  assert.throws(() => linkButtonRows([{ label: 'x', url: 'javascript:alert(1)' }]), /HTTPS/);
  assert.throws(() => linkButtonRows([{ label: 'x', url: 'https://example.com', custom_id: 'nova:retry' }]));
  assert.throws(() => linkButtonRows([{ label: '', url: 'https://example.com' }]));
});

test('MCP sends carry embeds and link buttons, allow embed-only messages and validate before any request', async () => {
  const { service, sends } = fixture();
  await sendMessage(service, { channelId, embeds: [{ title: 'Hello', color: '#ff0000' }], buttons: [{ label: 'Open', url: 'https://example.com' }], nonce: 'rich-send' });
  assert.deepEqual(sends()[0].payload, {
    embeds: [{ title: 'Hello', color: 0xff0000 }], components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open', url: 'https://example.com' }] }],
    allowed_mentions: { parse: [] }, nonce: 'rich-send', enforce_nonce: true,
  });
  await assert.rejects(() => sendMessage(service, { channelId, embeds: [{ title: 'x', imageUrl: 'http://example.com/a.png' }] }), /HTTPS/);
  await assert.rejects(() => sendMessage(service, { channelId, buttons: [{ label: 'Open', url: 'https://example.com' }] }), /content or at least one/);
  assert.equal(sends().length, 1);

  const server = createDiscordMcpServer(service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  for (const name of ['discord_send_message', 'discord_reply']) assert.ok(tools.find((tool) => tool.name === name).inputSchema.properties.embeds, name);
  const result = await client.callTool({ name: 'discord_send_message', arguments: { channelId, content: 'See below', embeds: [{ description: 'Card' }] } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(sends().at(-1).payload.embeds, [{ description: 'Card' }]);
  await client.close();
});

test('Nova reply plans accept embeds and buttons in bubbles and channel posts, and keep plain bubbles unchanged', () => {
  const context = { directMessages: true, expressions: { emojis: [{ markup: emojiMarkup }] } };
  const buttons = [{ label: 'Read', url: 'https://example.com/notes' }];
  const plan = validateReplyPlan({ shouldReply: true, messages: [{ content: '', gifUrl: null, stickerIds: [], embeds: [novaEmbed], buttons }, { content: 'plain', gifUrl: null, stickerIds: [], embeds: [], buttons: [] }],
    channelMessages: [{ channelId, content: '', notify: false, embeds: [novaEmbed], buttons: [] }] }, context);
  assert.deepEqual(plan.messages, [{ content: '', gifUrl: undefined, stickerIds: [], embeds: [novaEmbed], buttons }, { content: 'plain', gifUrl: undefined, stickerIds: [] }]);
  assert.deepEqual(plan.channelMessages, [{ channelId, content: '', notify: false, embeds: [novaEmbed] }]);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [{ content: 'x', gifUrl: null, stickerIds: [], embeds: [{ ...novaEmbed, description: '<:fake:400000000000000009>' }], buttons: [] }] }, context), /custom emoji/);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [{ content: 'x', gifUrl: null, stickerIds: [], embeds: [], buttons: [{ label: 'x', url: 'http://example.com' }] }] }, context), /HTTPS/);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [{ content: ' ', gifUrl: null, stickerIds: [], embeds: [], buttons }] }, context), /invalid message/);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], channelMessages: [{ channelId, content: ' ', notify: false, embeds: [], buttons }] }, context), /empty/);
});

test('the reply schema stays valid for strict structured output, and streaming publishes bubbles with nested embeds', () => {
  const strict = (schema, path = 'root') => {
    if (schema.anyOf) return schema.anyOf.forEach((item, index) => strict(item, `${path}|${index}`));
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false, path);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), path);
      for (const [key, value] of Object.entries(schema.properties)) strict(value, `${path}.${key}`);
    }
    if (schema.type === 'array') strict(schema.items, `${path}[]`);
  };
  strict(replySchema);
  const published = [];
  const stream = createReplyStream((message) => published.push(message));
  const bubble = { content: 'hi', gifUrl: null, stickerIds: [], embeds: [novaEmbed], buttons: [{ label: 'Read', url: 'https://example.com' }] };
  for (const character of JSON.stringify({ shouldReply: true, messages: [bubble] })) stream.push(character);
  assert.deepEqual(published, [bubble]);
});

test('the sender puts embeds and buttons on the last chunk, posts them cross-channel, and keeps link buttons when owner controls attach', async () => {
  const posts = [];
  const edits = [];
  const client = {
    sendMessage: async (channel, payload) => { posts.push({ channel, payload }); return { id: `40000000000000000${posts.length}`, channel_id: channel, content: payload.content }; },
    editMessage: async (_, id, payload) => { edits.push({ id, payload }); },
  };
  const ownerRow = { type: 1, components: [{ type: 2, style: 2, label: 'Details', custom_id: 'nova:details:opaque' }] };
  const target = { channel: { id: channelId, guild_id: guildId }, account: { id: 'reader', client } };
  const sender = createReplySender({ resolveChannel: async () => target }, { channelId, listenerId: 'fixture', directMessages: true, messageComponents: () => [ownerRow], sendTarget: async () => target });
  const trigger = { id: '300000000000000001' };
  const buttons = [{ label: 'Read', url: 'https://example.com/notes' }];
  await sender([{ content: 'long text '.repeat(300), stickerIds: [], embeds: [novaEmbed], buttons }], trigger);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].payload.embeds, undefined);
  assert.equal(posts[1].payload.embeds[0].title, 'Patch notes');
  assert.equal(posts[1].payload.components[0].components[0].url, 'https://example.com/notes');

  await sender([{ content: '', stickerIds: [], embeds: [novaEmbed], buttons }], { id: '300000000000000002' });
  assert.equal(posts[2].payload.content, undefined, 'embed-only bubbles send no empty content');
  assert.equal(await sender.controls({ id: '300000000000000002' }), true);
  assert.deepEqual(edits.at(-1).payload.components, [...linkButtonRows(buttons), ownerRow], 'owner buttons are appended, not swapped in');

  await sender.channelMessages([{ channelId, content: '', notify: false, embeds: [novaEmbed], buttons }], { id: '300000000000000003' });
  assert.equal(posts.at(-1).payload.embeds[0].color, 0x5865F2);
  assert.deepEqual(posts.at(-1).payload.allowed_mentions, { parse: [] });
  assert.equal(posts.at(-1).payload.components.length, 1);
});
