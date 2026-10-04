import assert from 'node:assert/strict';
import test from 'node:test';
import { createProgressReporter } from '../src/proactive/progress.mjs';

function fixture(options = {}) {
  const sent = [];
  let timestamp = 0;
  const progress = createProgressReporter({
    now: () => timestamp,
    send: async (content, signal, index) => { signal.throwIfAborted(); sent.push({ content, index }); return { sentMessages: [content] }; },
    ...options,
  });
  return { progress, sent, advance: (amount) => { timestamp += amount; } };
}

test('real tool actions describe their sanitized arguments without exposing model text or results', async () => {
  const { progress, sent } = fixture();
  await progress.receive({ stage: 'started', toolName: 'discord_search_messages', summary: 'private reasoning', arguments: { query: 'fate buff', channelIds: ['200000000000000001'], authorIds: ['400000000000000001'] }, result: 'private messages' });
  assert.deepEqual(sent, [{ content: 'I’m currently searching <#200000000000000001> for messages with "fate buff" from <@400000000000000001>.', index: 0 }]);
  assert.ok(!JSON.stringify(sent).includes('private'));
  for (const toolName of ['reasoning', 'shell', 'constructor', '__proto__']) await progress.receive({ stage: 'started', toolName });
  await progress.receive({ stage: 'reasoning', toolName: 'discord_search_messages' });
  assert.equal(sent.length, 1);
  progress.close();
});

test('progress deduplicates activities, throttles repeated tool work and limits each turn to three updates', async () => {
  const { progress, sent, advance } = fixture();
  await progress.receive({ stage: 'started', toolName: 'discord_list_servers' });
  await progress.receive({ stage: 'started', toolName: 'discord_list_channels' });
  await progress.receive({ stage: 'started', toolName: 'discord_search_messages' });
  await progress.receive({ stage: 'started', toolName: 'discord_search_messages' });
  advance(1500);
  await progress.receive({ stage: 'started', toolName: 'discord_message_context' });
  advance(5000);
  await progress.receive({ stage: 'started', toolName: 'discord_browse_messages' });
  await progress.receive({ stage: 'started', toolName: 'discord_user_info' });
  await progress.receive({ stage: 'failed', toolName: 'discord_search_messages' });
  assert.deepEqual(sent.map((entry) => entry.index), [0, 1, 2]);
  assert.match(sent[0].content, /servers/);
  assert.match(sent[1].content, /searching/);
  assert.match(sent[2].content, /conversation around that message/);
  progress.close();
});

test('only a completed longer search reports its result count', async () => {
  const { progress, sent, advance } = fixture();
  await progress.receive({ stage: 'completed', toolName: 'discord_search_messages', resultCount: 50 });
  await progress.receive({ stage: 'started', toolName: 'discord_search_messages' });
  await progress.receive({ stage: 'completed', toolName: 'discord_search_messages', resultCount: 50 });
  advance(5000);
  await progress.receive({ stage: 'completed', toolName: 'discord_search_messages', resultCount: 1 });
  await progress.receive({ stage: 'completed', toolName: 'discord_search_messages', resultCount: 50 });
  assert.deepEqual(sent.map((entry) => entry.content), ['I’m currently searching the server for messages.', 'I’m currently searching the server for messages and found 1 result.']);
  progress.close();
});

test('failed lookups show a factual failure without disclosing raw errors', async () => {
  const { progress, sent } = fixture();
  await progress.receive({ stage: 'failed', toolName: 'discord_search_messages', error: 'secret credential error' });
  assert.deepEqual(sent.map((entry) => entry.content), ['That search didn’t go through, so I don’t have those results yet.']);
  assert.ok(!JSON.stringify(sent).includes('secret'));
  progress.close();
});

test('progress delivery failures are bounded and do not reject the tool callback', async () => {
  let attempts = 0;
  let errors = 0;
  const { progress, advance } = fixture({
    send: async () => { attempts += 1; throw new Error('Send failed'); },
    onError: () => { errors += 1; },
  });
  for (const toolName of ['discord_list_servers', 'discord_search_messages', 'discord_message_context', 'discord_user_info']) {
    await progress.receive({ stage: 'started', toolName });
    advance(5000);
  }
  assert.equal(attempts, 3);
  assert.equal(errors, 3);
  progress.close();
});

test('closing cancels an active progress send and suppresses queued and late updates', async () => {
  const signals = [];
  const { progress } = fixture({ send: async (_, signal) => {
    signals.push(signal);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  } });
  const first = progress.receive({ stage: 'started', toolName: 'discord_list_servers' });
  const second = progress.receive({ stage: 'started', toolName: 'discord_search_messages' });
  await Promise.resolve();
  progress.close();
  await Promise.all([first, second]);
  await progress.receive({ stage: 'started', toolName: 'discord_message_context' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
});

test('listener and individual turn cancellation prevent progress sends', async () => {
  for (const source of ['listener', 'turn']) {
    const cancellation = new AbortController();
    const { progress, sent } = fixture({ signal: source === 'listener' ? cancellation.signal : undefined });
    cancellation.abort();
    await progress.receive({ stage: 'started', toolName: 'discord_search_messages' }, source === 'turn' ? cancellation.signal : undefined);
    assert.equal(sent.length, 0);
    progress.close();
  }
});

test('preparation and approved research tools describe activities without model text, links with credentials or raw paths', async () => {
  const names = ['voice_transcribe', 'image_read', 'reply_context', 'web_read_link', 'project_list', 'project_search', 'project_read_file', 'discord_research_topic', 'read_tool_result'];
  for (const toolName of names) {
    const sent = [];
    const edits = [];
    const progress = createProgressReporter({ send: async (content) => { sent.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { edits.push(content); } });
    await progress.receive({ stage: 'started', toolName, arguments: { file: '/Users/owner/secret-dir/notes.md', query: 'roadmap', url: 'https://user:token@docs.example.com/private?key=1' }, summary: 'private reasoning' });
    assert.equal(sent.length, 1, toolName);
    assert.match(sent[0], /^I’m /);
    assert.ok(!/private|secret-dir|token|key=1|user:/.test(JSON.stringify([...sent, ...edits, ...progress.details()])), toolName);
    assert.equal(progress.details()[0].toolName, toolName);
    progress.close();
  }
});

test('owner cancellation edits an existing activity to stopped and never reports successful completion', async () => {
  const edits = [];
  let removed = false;
  const progress = createProgressReporter({ send: async () => ({ sentMessages: [{ message: { id: 'message' } }] }), edit: async (_, content) => { edits.push(content); }, remove: async () => { removed = true; } });
  await progress.receive({ stage: 'started', toolName: 'project_search' });
  await progress.finish({ cancelled: true });
  assert.deepEqual(edits, ['Stopped this answer.']);
  assert.equal(removed, false);
  await progress.receive({ stage: 'completed', toolName: 'project_search', resultCount: 5 });
  assert.deepEqual(edits, ['Stopped this answer.']);
});

test('batch searches and app calls read like an assistant, and argument text cannot inject mentions or markup', async () => {
  const lines = [];
  const progress = createProgressReporter({ send: async (content) => { lines.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { lines.push(content); }, intervalMs: 0 });
  const searches = [{ query: 'fate' }, { query: 'hero bow', channelIds: ['200000000000000002'] }, { query: 'crimson moon' }, { query: 'nerf' }];
  await progress.receive({ stage: 'started', toolName: 'discord_search_batch', arguments: { guildId: '100000000000000001', channelIds: ['200000000000000001'], searches } });
  await progress.receive({ stage: 'completed', toolName: 'discord_search_batch', arguments: { guildId: '100000000000000001', channelIds: ['200000000000000001'], searches }, resultCount: 42 });
  assert.deepEqual(lines, [
    'I’m currently searching <#200000000000000001> and <#200000000000000002> for 4 keywords: "fate", "hero bow", "crimson moon" and 1 more.',
    'I searched <#200000000000000001> and <#200000000000000002> for 4 keywords: "fate", "hero bow", "crimson moon" and 1 more and found 42 results.',
  ]);
  await progress.receive({ stage: 'started', toolName: 'apps_call_tool', arguments: { tool: 'google_drive.get_spreadsheet_cells' } });
  assert.equal(lines.at(-1), 'I’m checking your Google Drive.');
  await progress.receive({ stage: 'started', toolName: 'discord_search_messages', arguments: { query: '@everyone <@&123456789012345678> **bold**\nline', channelIds: ['not-a-channel'] } });
  assert.equal(lines.at(-1), 'I’m currently searching the server for messages with "everyone &123456789012345678 bold line".');
  assert.ok(!/[@<>*]/.test(lines.at(-1).replace(/<#\d+>|<@\d+>/g, '')));
  progress.close();
});
