import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DiscordService } from '../src/service.mjs';
import { createDiscordMcpServer } from '../src/server.mjs';
import { createEmoji, createSticker, expressionName, importExpressionFolder } from '../src/expression-uploads.mjs';

const guildId = '100000000000000001';
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32, 2)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 3)]);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function folder(files) {
  const root = await mkdtemp(join(tmpdir(), 'nova-expressions-'));
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes);
  return root;
}

function fixture({ emojis = [], stickers = [], failWith } = {}) {
  const requests = [];
  let next = 0;
  const service = new DiscordService({
    accounts: [{ id: 'admin', token: 'mock-token' }],
    sleep: async () => {},
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.hostname === 'cdn.discordapp.com') return new Response(png, { headers: { 'content-type': 'image/png' } });
      const path = url.pathname.replace('/api/v10', '');
      const form = options.body instanceof FormData ? options.body : null;
      const payload = form ? Object.fromEntries([...form.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : { type: value.type, size: value.size, name: value.name }])) : options.body ? JSON.parse(options.body) : null;
      if (options.method !== 'GET') requests.push({ path, method: options.method, payload, headers: options.headers });
      if (path === '/users/@me') return json({ id: '500000000000000001', username: 'Nova', bot: true });
      if (path === '/users/@me/guilds') return json([{ id: guildId, name: 'Example' }]);
      if (path === `/guilds/${guildId}`) return json({ id: guildId, name: 'Example' });
      if (options.method === 'GET' && path === `/guilds/${guildId}/emojis`) return json(emojis);
      if (options.method === 'GET' && path === `/guilds/${guildId}/stickers`) return json(stickers);
      if (failWith) { const failure = failWith(payload, requests.length); if (failure) return failure; }
      next += 1;
      if (path === `/guilds/${guildId}/emojis`) return json({ id: `70000000000000000${next}`, name: payload.name, animated: payload.image.startsWith('data:image/gif'), available: true, roles: [] });
      if (path === `/guilds/${guildId}/stickers`) return json({ id: `80000000000000000${next}`, name: payload.name, description: payload.description, tags: payload.tags, format_type: payload.file.type === 'image/gif' ? 4 : 1, available: true });
      throw new Error(`Unexpected route: ${options.method} ${path}`);
    },
  });

  return { service, requests };
}

test('derives Discord-safe names from file names', () => {
  assert.equal(expressionName('C:/pics/Happy Cat!.png', 'emoji'), 'Happy_Cat');
  assert.equal(expressionName('/pics/--wave--.gif', 'emoji'), 'wave');
  assert.equal(expressionName('/pics/A sticker with a very long file name here.png', 'sticker'), 'A sticker with a very long fil');
});

test('uploads an emoji from a local file as a data URI, named after the file, with an audit reason', async (t) => {
  const root = await folder({ 'party parrot.gif': gif });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { service, requests } = fixture();
  const result = await createEmoji(service, { guildId, filePath: join(root, 'party parrot.gif'), reason: 'owner asked' });
  assert.equal(result.emoji.name, 'party_parrot');
  assert.equal(result.emoji.animated, true);
  assert.match(result.emoji.markup, /^<a:party_parrot:\d+>$/);
  assert.equal(requests[0].path, `/guilds/${guildId}/emojis`);
  assert.equal(requests[0].payload.image, `data:image/gif;base64,${gif.toString('base64')}`);
  assert.equal(requests[0].headers['X-Audit-Log-Reason'], 'owner%20asked');
});

test('uploads a sticker as multipart form data and copies an emoji from Discord\'s CDN', async (t) => {
  const root = await folder({ 'wave.png': png });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { service, requests } = fixture();
  const sticker = await createSticker(service, { guildId, filePath: join(root, 'wave.png'), description: 'Waving hello', tags: 'wave' });
  assert.deepEqual({ name: sticker.sticker.name, tags: sticker.sticker.tags, guildId: sticker.sticker.guildId }, { name: 'wave', tags: 'wave', guildId });
  assert.deepEqual(requests[0].payload, { name: 'wave', description: 'Waving hello', tags: 'wave', file: { type: 'image/png', size: png.length, name: 'sticker.png' } });

  const copied = await createEmoji(service, { guildId, name: 'copied', imageUrl: 'https://cdn.discordapp.com/emojis/123.png' });
  assert.equal(copied.emoji.name, 'copied');
  await assert.rejects(() => createEmoji(service, { guildId, imageUrl: 'https://cdn.discordapp.com/emojis/123.png' }), /name is required/);
  await assert.rejects(() => createEmoji(service, { guildId, name: 'evil', imageUrl: 'https://example.com/x.png' }), /approved Discord media host/);
  assert.equal(requests.length, 2);
});

test('refuses relative paths, wrong extensions, disguised files and oversized images before uploading', async (t) => {
  const root = await folder({ 'notes.txt': 'hello', 'fake.png': Buffer.from('not an image'), 'photo.jpg': jpeg, 'big.png': Buffer.concat([png, Buffer.alloc(300 * 1024)]) });
  await mkdir(join(root, 'dir.png'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { service, requests } = fixture();
  await assert.rejects(() => createEmoji(service, { guildId, filePath: 'pics/cat.png' }), /absolute path/);
  await assert.rejects(() => createEmoji(service, { guildId, filePath: join(root, 'notes.txt') }), /must end in/);
  await assert.rejects(() => createEmoji(service, { guildId, filePath: join(root, 'fake.png') }), /not a supported image/);
  await assert.rejects(() => createEmoji(service, { guildId, filePath: join(root, 'big.png') }), /at most 256 KiB/);
  await assert.rejects(() => createEmoji(service, { guildId, filePath: join(root, 'dir.png') }), /not a file/);
  await assert.rejects(() => createSticker(service, { guildId, filePath: join(root, 'photo.jpg') }), /must end in/);
  await assert.rejects(() => createEmoji(service, { guildId, name: 'x', filePath: join(root, 'fake.png') }), /2 to 32/);
  await assert.rejects(() => createEmoji(service, { guildId, filePath: join(root, 'fake.png'), imageUrl: 'https://cdn.discordapp.com/a.png' }), /exactly one/);
  await assert.rejects(() => createSticker(service, { guildId, filePath: join(root, 'fake.png'), description: 'x' }), /description/);
  assert.equal(requests.length, 0);
});

test('a folder import previews, skips existing names and duplicates, and is safe to re-run', async (t) => {
  const root = await folder({ 'cat.png': png, 'dog.gif': gif, 'dog.png': png, 'x.png': png, 'readme.md': 'skip', '.hidden.png': png, 'fake.webp': Buffer.from('nope') });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { service, requests } = fixture({ emojis: [{ id: '700000000000000099', name: 'CAT' }] });

  const preview = await importExpressionFolder(service, { guildId, folderPath: root, dryRun: true });
  assert.deepEqual(preview.wouldCreate.map((item) => item.file), ['dog.gif']);
  assert.deepEqual(preview.skipped.map((item) => item.file), ['cat.png', 'dog.png', 'fake.webp', 'x.png']);
  assert.equal(requests.length, 0);

  const result = await importExpressionFolder(service, { guildId, folderPath: root });
  assert.deepEqual(result.created.map((item) => item.emoji.name), ['dog']);
  assert.deepEqual(result.notAttempted, []);
  assert.equal(requests.length, 1);
});

test('a folder import honours the limit, stops on full slots and on unknown outcomes', async (t) => {
  const root = await folder({ 'a1.png': png, 'a2.png': png, 'a10.png': png, 'a3.png': png });
  t.after(() => rm(root, { recursive: true, force: true }));

  const limited = await importExpressionFolder(fixture().service, { guildId, folderPath: root, kind: 'sticker', limit: 2 });
  assert.deepEqual(limited.created.map((item) => item.sticker.name), ['a1', 'a2']);
  assert.deepEqual(limited.notAttempted, ['a3.png', 'a10.png']);

  const full = fixture({ failWith: (payload, count) => count === 2 ? json({ message: 'Maximum number of emojis reached (50)', code: 30008 }, 400) : null });
  const stopped = await importExpressionFolder(full.service, { guildId, folderPath: root });
  assert.deepEqual(stopped.created.map((item) => item.emoji.name), ['a1']);
  assert.equal(stopped.failed[0].sendStatus, 'rejected');
  assert.match(stopped.stopped, /Maximum number of emojis/);
  assert.deepEqual(stopped.notAttempted, ['a3.png', 'a10.png']);

  const rejectedOnce = fixture({ failWith: (payload, count) => count === 1 ? json({ message: 'Invalid Form Body', code: 50035 }, 400) : null });
  const continued = await importExpressionFolder(rejectedOnce.service, { guildId, folderPath: root });
  assert.deepEqual(continued.created.map((item) => item.emoji.name), ['a2', 'a3', 'a10']);
  assert.equal(continued.stopped, undefined);

  const unknown = fixture({ failWith: () => json({ message: 'Internal' }, 500) });
  const halted = await importExpressionFolder(unknown.service, { guildId, folderPath: root });
  assert.equal(halted.failed.length, 1);
  assert.equal(halted.failed[0].sendStatus, 'unknown');
  assert.match(halted.stopped, /may have been created/);
  assert.equal(unknown.requests.length, 1);
});

test('single uploads are not retried and warn when the outcome is unknown', async (t) => {
  const root = await folder({ 'cat.png': png });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { service, requests } = fixture({ failWith: () => json({ message: 'Internal' }, 502) });
  await assert.rejects(() => createEmoji(service, { guildId, filePath: join(root, 'cat.png') }), (error) => error.sendStatus === 'unknown' && /may have been created/.test(error.message));
  assert.equal(requests.length, 1);
});

test('MCP exposes the expression upload tools as non-read-only writes', async (t) => {
  const root = await folder({ 'cat.png': png });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { service } = fixture();
  const server = createDiscordMcpServer(service);
  const client = new Client({ name: 'expression-upload-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    for (const name of ['discord_create_emoji', 'discord_create_sticker', 'discord_import_expressions']) assert.equal(tools.find((tool) => tool.name === name)?.annotations.readOnlyHint, false, name);
    const imported = await client.callTool({ name: 'discord_import_expressions', arguments: { guildId, folderPath: root, dryRun: true } });
    assert.deepEqual(imported.structuredContent.wouldCreate.map((item) => item.name), ['cat']);
    const refused = await client.callTool({ name: 'discord_create_emoji', arguments: { guildId, filePath: 'cat.png' } });
    assert.equal(refused.isError, true);
  } finally { await client.close(); await server.close(); }
});
