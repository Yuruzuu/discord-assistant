import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordService } from '../src/service.mjs';
import { validateReplyPlan } from '../src/proactive/reply-validation.mjs';
import { createReplyStream } from '../src/proactive/reply-stream.mjs';
import { replySchema } from '../src/proactive/reply-style.mjs';
import { createDiscordReadTools } from '../src/proactive/read-tools.mjs';
import { createReplySender } from '../src/proactive/reply-sender.mjs';
import { createProactiveEngine } from '../src/proactive/engine.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';
import { createProgressReporter, displayLocalPath } from '../src/proactive/progress.mjs';

const guildId = '100000000000000001';
const dmId = '200000000000000004';
const botUserId = '500000000000000001';
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function folder(files) {
  const root = await mkdtemp(join(tmpdir(), 'nova-uploads-'));
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes);
  return root;
}

function service({ emojis = [], failWith } = {}) {
  const uploads = [];
  const discord = new DiscordService({
    accounts: [{ id: 'nova', token: 'mock-token' }],
    sleep: async () => {},
    fetchImpl: async (input, options) => {
      const path = new URL(input).pathname.replace('/api/v10', '');
      if (path === '/users/@me') return json({ id: botUserId, username: 'Nova', bot: true });
      if (path === '/users/@me/guilds') return json([{ id: guildId, name: 'Vanguards Dev' }]);
      if (path === `/guilds/${guildId}`) return json({ id: guildId, name: 'Vanguards Dev' });
      if (options.method === 'GET' && path === `/guilds/${guildId}/emojis`) return json(emojis);
      if (options.method === 'GET' && path === `/guilds/${guildId}/stickers`) return json([]);
      const payload = options.body instanceof FormData ? Object.fromEntries([...options.body.entries()].filter(([, value]) => typeof value === 'string')) : JSON.parse(options.body);
      uploads.push({ path, payload, reason: options.headers['X-Audit-Log-Reason'] });
      const failure = failWith?.(payload, uploads.length);
      if (failure) return failure;
      if (path.endsWith('/emojis')) { const emoji = { id: `70000000000000000${uploads.length}`, name: payload.name, animated: false }; emojis.push(emoji); return json(emoji); }
      return json({ id: `80000000000000000${uploads.length}`, name: payload.name, tags: payload.tags, format_type: 1 });
    },
  });
  return { service: discord, uploads };
}

test('upload plans are owner-DM-only, deduplicated, need absolute paths and are dropped when not replying', () => {
  const item = { guildId, kind: 'emoji', filePath: 'C:/Users/me/Downloads/cat.png', name: null, tags: null };
  assert.deepEqual(validateReplyPlan({ shouldReply: true, messages: [], expressionUploads: [item, item, { ...item, kind: 'sticker', name: 'Cat', tags: 'cat' }] }, { directMessages: true }).expressionUploads, [
    { guildId, kind: 'emoji', filePath: item.filePath }, { guildId, kind: 'sticker', filePath: item.filePath, name: 'Cat', tags: 'cat' },
  ]);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], expressionUploads: [item] }, { channelId: '200000000000000001', guildId }), /outside the owner DM/);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], expressionUploads: [{ ...item, filePath: 'Downloads/cat.png' }] }, { directMessages: true }), /absolute path/);
  assert.throws(() => validateReplyPlan({ shouldReply: true, messages: [], expressionUploads: [{ ...item, kind: 'gif' }] }, { directMessages: true }));
  assert.equal(validateReplyPlan({ shouldReply: false, messages: [], expressionUploads: [item] }, { directMessages: true }).expressionUploads, undefined);
  assert.ok(replySchema.required.includes('expressionUploads'));
  const stream = createReplyStream(() => {});
  assert.doesNotThrow(() => stream.push(JSON.stringify({ shouldReply: true, messages: [], expressionUploads: [item] })));
});

test('folders are listable only from the owner DM, never through MCP, and listing closes web links for the turn', async (t) => {
  const root = await folder({ 'cat.png': png, 'big.gif': Buffer.alloc(300 * 1024), 'notes.txt': 'x', '.hidden.png': png });
  await mkdir(join(root, 'packs'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = { accounts: [], resolveGuild: async (id) => ({ account: { id: 'nova' }, guild: { id, name: 'Vanguards Dev' } }) };
  assert.equal(createDiscordReadTools(fake, { channelId: '200000000000000001', guildId, directMessages: false }).has('local_list_images'), false);
  assert.equal(createDiscordReadTools(fake, { trustedLocal: true, directMessages: true }).has('local_list_images'), false);
  assert.equal(createDiscordReadTools(fake, { channelId: dmId, directMessages: true }, { localFiles: false }).has('local_list_images'), false);

  const dm = createDiscordReadTools(fake, { channelId: dmId, guildId: null, directMessages: true });
  const listing = JSON.parse((await dm.call('local_list_images', { folderPath: root })).contentItems[0].text);
  assert.deepEqual(listing.folders, ['packs']);
  assert.deepEqual(listing.images.map(({ name, emoji, sticker }) => ({ name, emoji, sticker })), [{ name: 'big.gif', emoji: false, sticker: true }, { name: 'cat.png', emoji: true, sticker: true }]);
  assert.equal(listing.images[1].path, join(root, 'cat.png'));
  assert.equal(listing.untrustedContent, true);
  await assert.rejects(() => dm.call('web_read_link', { url: 'https://example.com/?q=cat.png' }), /listing folders/);
  dm.beginTurn();
  await assert.rejects(() => dm.call('local_list_images', { folderPath: 'relative/folder' }), /absolute path/);
});

test('upload targets are owner-DM-only and refused after connected-app reads', async () => {
  const fake = { accounts: [], resolveGuild: async (id) => ({ account: { id: 'nova' }, guild: { id } }) };
  await assert.rejects(() => createDiscordReadTools(fake, { channelId: '200000000000000001', guildId, directMessages: false }).expressionTarget(guildId), /Only the owner DM/);
  await assert.rejects(() => createDiscordReadTools(fake, { channelId: dmId, directMessages: true }, { localFiles: false }).expressionTarget(guildId), /turned off/);
  const connectedApps = { list: async () => ({}), call: async () => ({ text: 'private' }) };
  const dm = createDiscordReadTools(fake, { channelId: dmId, guildId: null, directMessages: true }, { connectedApps });
  assert.equal((await dm.expressionTarget(guildId)).guild.id, guildId);
  await dm.call('apps_call_tool', { tool: 'gmail.search_emails', arguments: {} });
  await assert.rejects(() => dm.expressionTarget(guildId), /connected-app data/);
});

test('the sender uploads through the scope check, skips existing names, continues past rejections and stops on unknown outcomes', async (t) => {
  const root = await folder({ 'cat.png': png, 'dog.png': png, 'fox.png': png, 'owl.png': png });
  t.after(() => rm(root, { recursive: true, force: true }));
  const items = ['cat', 'dog', 'fox', 'owl'].map((name) => ({ guildId, kind: 'emoji', filePath: join(root, `${name}.png`) }));
  const trigger = { id: '300000000000000001' };

  const refused = await createReplySender({}, { channelId: dmId, listenerId: 'fixture' }).expressionUploads(items.slice(0, 1), trigger);
  assert.match(refused.failed[0].error, /unavailable in this conversation/);

  const { service: discord, uploads } = service({ emojis: [{ id: '700000000000000099', name: 'Cat' }], failWith: (payload) => payload.name === 'dog' ? json({ message: 'Invalid Form Body', code: 50035 }, 400) : null });
  const send = createReplySender(discord, { channelId: dmId, listenerId: 'fixture', directMessages: true, expressionTarget: (id) => discord.resolveGuild(id) });
  const updates = [];
  const result = await send.expressionUploads([...items, { ...items[3], kind: 'sticker', tags: 'owl' }], trigger, undefined, { onUpdate: async (states) => { updates.push(states.map((item) => item.state).join(',')); } });
  assert.equal(updates[0], 'pending,pending,pending,pending,pending', 'every file is announced before the first upload');
  assert.ok(updates.includes('skipped,uploading,pending,pending,pending'));
  assert.equal(updates.at(-1), 'skipped,failed,uploaded,uploaded,uploaded');
  assert.deepEqual(result.items.map((item) => [item.path, item.guildName]), [...items, items[3]].map((item) => [item.filePath, 'Vanguards Dev']));
  assert.deepEqual(result.skipped.map((item) => item.file), ['cat.png']);
  assert.deepEqual(result.failed.map((item) => [item.file, item.sendStatus]), [['dog.png', 'rejected']]);
  assert.deepEqual(result.uploaded.map((item) => [item.name, item.kind, item.guildName]), [['fox', 'emoji', 'Vanguards Dev'], ['owl', 'emoji', 'Vanguards Dev'], ['owl', 'sticker', 'Vanguards Dev']]);
  assert.match(result.uploaded[0].emoji.markup, /^<:fox:\d+>$/);
  assert.equal(uploads.at(-1).payload.tags, 'owl');
  assert.ok(uploads.every((upload) => upload.reason === encodeURIComponent('Requested by the owner through Nova')));

  const replay = await createReplySender(discord, { channelId: dmId, listenerId: 'fixture', directMessages: true, expressionTarget: (id) => discord.resolveGuild(id) }).expressionUploads(items.slice(2, 3), trigger);
  assert.deepEqual([replay.uploaded.length, replay.skipped[0]?.file], [0, 'fox.png'], 'a replayed plan after a restart skips what the server already has');

  const unknown = service({ failWith: () => json({ message: 'Internal' }, 500) });
  const halted = await createReplySender(unknown.service, { channelId: dmId, listenerId: 'fixture', directMessages: true, expressionTarget: (id) => unknown.service.resolveGuild(id) }).expressionUploads(items, trigger);
  assert.equal(halted.failed[0].sendStatus, 'unknown');
  assert.equal(halted.notAttempted, 3);
  assert.equal(unknown.uploads.length, 1);
});

test('the engine shows a live checklist naming each file, kind, name and server before uploading, then edits it with the outcome', async () => {
  const posts = [];
  const edits = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sendReplies = async (messages) => ({ sentMessages: messages });
  sendReplies.confirmation = async (content, trigger, signal, options) => { posts.push({ content, options }); return { sentMessages: [{ message: { id: '700000000000000050' } }] }; };
  sendReplies.editConfirmation = async (receipt, content) => { assert.equal(receipt.message.id, '700000000000000050'); edits.push(content); };
  const base = [
    { guildId, guildName: 'Vanguards Dev', kind: 'emoji', path: 'C:/art/fox.png', file: 'fox.png', name: 'fox' },
    { guildId, guildName: null, kind: 'sticker', path: 'C:/art/owl.png', file: 'owl.png', name: 'owl' },
    { guildId, guildName: 'Vanguards Dev', kind: 'emoji', path: 'C:/other/cat.png', file: 'cat.png', name: 'cat' },
  ];
  const final = [
    { ...base[0], state: 'uploaded', emoji: { markup: '<:fox:700000000000000001>' } },
    { ...base[1], state: 'failed', error: 'Discord API 500: Internal', sendStatus: 'unknown' },
    { ...base[2], state: 'not-attempted' },
  ];
  sendReplies.expressionUploads = async (items, trigger, signal, { onUpdate }) => {
    onUpdate(base.map((item) => ({ ...item, state: 'pending' })));
    await gate;
    onUpdate([{ ...base[0], state: 'uploading' }, ...base.slice(1).map((item) => ({ ...item, state: 'pending' }))]);
    return { items: final, uploaded: [final[0]], skipped: [], failed: [final[1]], notAttempted: 1 };
  };
  const engine = createProactiveEngine({
    botUserId, channelId: dmId, directMessages: true, batchWindowMs: 5, cooldownMs: 0,
    resolveReplyAuthor: async () => botUserId, getContext: async () => ({ recentMessages: [] }),
    generateReply: async () => ({ shouldReply: true, messages: [{ content: 'Uploading them now!' }], expressionUploads: base.map(({ guildId: id, kind, path }) => ({ guildId: id, kind, filePath: path })) }), sendReplies,
  });
  try {
    await engine.receive({ id: '300000000000000009', channel_id: dmId, author: { id: directMessageOwnerId, bot: false }, content: 'upload my art', mentions: [] });
    for (let attempt = 0; attempt < 200 && !posts.length; attempt += 1) await wait(5);
    assert.equal(posts[0].content, [
      '📤 Uploading *3* files from your computer',
      '📂 `C:/art`',
      '⏳ `fox.png` → emoji **fox** in **Vanguards Dev**',
      `⏳ \`owl.png\` → sticker **owl** in server ${guildId}`,
      '📂 `C:/other`',
      '⏳ `cat.png` → emoji **cat** in **Vanguards Dev**',
    ].join('\n'), 'the plan is visible before anything is uploaded');
    assert.deepEqual(posts[0].options, { key: 'expression-confirmation', suffix: 'ke' });
    release();
    for (let attempt = 0; attempt < 200 && !edits.at(-1)?.startsWith('📤 Uploaded'); attempt += 1) await wait(5);
    assert.equal(edits.at(-1), [
      '📤 Uploaded *1* of *3* files from your computer',
      '⏹️ Stopped before *1* more file because an upload’s outcome is unknown; check the server before asking again.',
      '📂 `C:/art`',
      '✅ `fox.png` → emoji <:fox:700000000000000001> **fox** in **Vanguards Dev**',
      `⚠️ \`owl.png\` → sticker **owl** in server ${guildId} · couldn’t upload: Discord API 500: Internal`,
      '📂 `C:/other`',
      '⏹️ `cat.png` → emoji **cat** in **Vanguards Dev** · not attempted',
    ].join('\n'));
    assert.equal(posts.length, 1, 'the checklist is one message edited in place');
    for (let attempt = 0; attempt < 200 && engine.status().expressionUploads < 1; attempt += 1) await wait(5);
    assert.equal(engine.status().expressionUploads, 1);
  } finally { engine.stop(); }
});

test('the progress trace says which folder on the computer Nova is browsing', async () => {
  const edits = [];
  const sent = [];
  const progress = createProgressReporter({ intervalMs: 0, send: async (content) => { sent.push(content); return { id: 'trace' }; }, edit: async (_, content) => { edits.push(content); } });
  const folderPath = join(homedir(), 'Downloads', 'stickers');
  await progress.receive({ stage: 'started', toolName: 'local_list_images', callId: 'a', arguments: { folderPath } });
  await progress.idle();
  assert.match(sent[0], /^-# 📂 I’m browsing `~[\\/]Downloads[\\/]stickers` on your computer\.\n```\nlocal_list_images\(\{"folderPath":".*stickers"\}\)\n```$/);
  await progress.receive({ stage: 'completed', toolName: 'local_list_images', callId: 'a', arguments: { folderPath }, resultCount: 4 });
  for (let attempt = 0; attempt < 200 && !edits.length; attempt += 1) await wait(5);
  assert.match(edits.at(-1), /^-# 📂 I’ve browsed `~[\\/]Downloads[\\/]stickers` on your computer and found \*4\* images\.$/);
  await progress.finish();
  assert.match(edits.at(-1), /^-# ✅ I browsed `~[\\/]Downloads[\\/]stickers` on your computer\.$/);
  assert.equal(displayLocalPath('C:\\Users\\me\\Pictures', 'C:\\Users\\me'), '`~\\Pictures`');
  assert.equal(displayLocalPath('C:/Users/me/Pictures', 'C:\\Users\\me'), '`~/Pictures`');
  assert.equal(displayLocalPath('C:\\Users\\meX\\a', 'C:\\Users\\me'), '`C:\\Users\\meX\\a`');
});
