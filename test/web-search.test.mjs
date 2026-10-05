import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexResponder } from '../src/proactive/codex-responder.mjs';
import { webSearchMode } from '../src/proactive/channel-runtime.mjs';
import { createProgressReporter } from '../src/proactive/progress.mjs';
import { fakeCodexServer } from './helpers/codex-app-server.mjs';

const context = { channelId: '200000000000000001', guildId: null, directMessages: true, expressions: { emojis: [], stickers: [] }, allowedGifUrls: [], recentMessages: [], triggerMessages: [] };

test('auto web search is cached in the owner DM with connected apps and live elsewhere', () => {
  assert.equal(webSearchMode({}, { directMessages: true }), 'cached');
  assert.equal(webSearchMode({ apps: false }, { directMessages: true }), 'live');
  assert.equal(webSearchMode({}, { directMessages: false }), 'live');
  assert.equal(webSearchMode({ webSearch: 'live' }, { directMessages: true }), 'live');
  assert.equal(webSearchMode({ webSearch: 'disabled' }, { directMessages: false }), 'disabled');
});

test('the conversation enables the chosen web search mode and reports searches as progress', async () => {
  assert.throws(() => createCodexResponder({ webSearch: 'everything' }), /webSearch must be/);
  const server = fakeCodexServer({ events: [
    { method: 'item/started', params: { item: { type: 'webSearch', id: 'ws1', query: 'anime vanguards patch notes' } } },
    { method: 'item/completed', params: { item: { type: 'webSearch', id: 'ws1', query: 'anime vanguards patch notes', action: { type: 'search', query: 'anime vanguards patch notes' } } } },
    { method: 'item/started', params: { item: { type: 'webSearch', id: 'ws2', query: '', action: { type: 'openPage', url: 'https://example.com/patch' } } } },
  ] });
  const respond = createCodexResponder({ spawnImpl: server.spawnImpl, webSearch: 'cached' });
  const events = [];
  try {
    await respond(context, undefined, { onProgress: async (event) => { events.push(event); } });
    const start = server.requests.find((request) => request.method === 'thread/start').params;
    assert.equal(start.config.web_search, 'cached');
    assert.deepEqual(events.map(({ stage, toolName, callId, arguments: args }) => [stage, toolName, callId, args]), [
      ['started', 'web_search', 'ws1', { query: 'anime vanguards patch notes', url: '' }],
      ['completed', 'web_search', 'ws1', { query: 'anime vanguards patch notes', url: '' }],
      ['started', 'web_search', 'ws2', { query: '', url: 'https://example.com/patch' }],
    ]);
  } finally { await respond.close(); }
  const disabled = fakeCodexServer({});
  const quiet = createCodexResponder({ spawnImpl: disabled.spawnImpl });
  try { await quiet.warmup(); assert.equal(disabled.requests.find((request) => request.method === 'thread/start').params.config.web_search, 'disabled'); }
  finally { await quiet.close(); }
});

test('web searches and opened pages read naturally in the progress log', async () => {
  const lines = [];
  const progress = createProgressReporter({ intervalMs: 0, send: async (content) => { lines.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { lines.push(content); } });
  await progress.receive({ stage: 'started', toolName: 'web_search', callId: 'a', arguments: { query: '', url: '' } });
  assert.equal(lines.at(-1), 'I’m searching the web.\n```\nweb_search({"query":""})\n```', 'Codex sends the query only when the search finishes');
  await progress.receive({ stage: 'completed', toolName: 'web_search', callId: 'a', arguments: { query: 'fate buff <@&123> **news**', url: '' } });
  assert.equal(lines.at(-1), 'I’ve searched the web for "fate buff &123 news".');
  await progress.receive({ stage: 'started', toolName: 'web_search', callId: 'b', arguments: { query: '', url: 'https://user:token@docs.example.com/private?key=1' } });
  assert.equal(lines.at(-1), 'I’ve searched the web for "fate buff &123 news".\nI’m opening docs.example.com.\n```\nweb_search({"query":"","url":"docs.example.com"})\n```');
  assert.ok(!/user:|token|private|key=1/.test(lines.join('\n')), 'URL credentials, paths and query parameters remain private');
  await progress.receive({ stage: 'completed', toolName: 'web_search', callId: 'b', arguments: { query: '', url: 'https://user:token@docs.example.com/private?key=1' } });
  await progress.finish();
  assert.equal(lines.at(-1), 'I searched the web for "fate buff &123 news", and opened docs.example.com.');
  assert.ok(!lines.at(-1).includes('```'));
});
