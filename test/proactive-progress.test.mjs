import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createProgressReporter } from '../src/proactive/progress.mjs';

const activeLine = (activity, command) => `${activity}\n\`\`\`\n${command}\n\`\`\``;
const withoutTrace = (content) => content.replace(/\n```\n[^]*?\n```/g, '');

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
  assert.deepEqual(sent.map((entry) => entry.content), ['I’m currently searching the server for messages.', 'I’ve searched the server for messages and found *1* result.']);
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
    assert.match(sent[0], /\n```\n[A-Za-z_]+\(\{/);
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
  assert.deepEqual(edits, ['I’m searching your project files for "".\nStopped this answer.']);
  assert.equal(removed, false);
  await progress.receive({ stage: 'completed', toolName: 'project_search', resultCount: 5 });
  assert.equal(edits.length, 1, 'nothing reports success after a stop');
});

test('batch searches and app calls read like an assistant, and argument text cannot inject mentions or markup', async () => {
  const lines = [];
  const progress = createProgressReporter({ send: async (content) => { lines.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { lines.push(content); }, intervalMs: 0 });
  const searches = [{ query: 'fate' }, { query: 'hero bow', channelIds: ['200000000000000002'] }, { query: 'crimson moon' }, { query: 'nerf' }];
  await progress.receive({ stage: 'started', toolName: 'discord_search_batch', arguments: { guildId: '100000000000000001', channelIds: ['200000000000000001'], searches } });
  await progress.receive({ stage: 'completed', toolName: 'discord_search_batch', arguments: { guildId: '100000000000000001', channelIds: ['200000000000000001'], searches }, resultCount: 42 });
  assert.deepEqual(lines, [
    activeLine('I’m currently searching <#200000000000000001> and <#200000000000000002> for *4* keywords: "fate", "hero bow", "crimson moon" and *1* more.', 'discord_search_batch({"guildId":"100000000000000001","channelIds":["200000000000000001"]})'),
    'I’ve searched <#200000000000000001> and <#200000000000000002> for *4* keywords: "fate", "hero bow", "crimson moon" and *1* more and found *42* results.',
  ]);
  assert.ok(!lines[1].includes('```'), 'completed searches remove their trace immediately');
  await progress.receive({ stage: 'started', toolName: 'apps_call_tool', arguments: { tool: 'google_drive.get_spreadsheet_cells' } });
  assert.equal(withoutTrace(lines.at(-1)).split('\n').at(-1), 'I’m reading spreadsheet cells in your Google Drive.');
  assert.ok(lines.at(-1).endsWith('```\napps_call_tool({"tool":"google_drive.get_spreadsheet_cells"})\n```'));
  await progress.receive({ stage: 'started', toolName: 'discord_search_messages', arguments: { query: '@everyone <@&123456789012345678> **bold**\nline', channelIds: ['not-a-channel'] } });
  const last = withoutTrace(lines.at(-1)).split('\n').at(-1);
  assert.equal(last, 'I’m currently searching the server for messages with "everyone &123456789012345678 bold line".');
  assert.ok(!/[@<>*]/.test(last.replace(/<#\d+>|<@\d+>/g, '')));
  progress.close();
});

test('the progress log edits each step from doing to done, defers throttled edits, and ends as a one-sentence summary', async () => {
  const sent = [];
  const edits = [];
  let clock = 0;
  const progress = createProgressReporter({ intervalMs: 30, now: () => clock,
    send: async (content) => { sent.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; },
    edit: async (_, content, signal, options) => { edits.push({ content, options }); } });
  await progress.receive({ stage: 'started', toolName: 'apps_list_tools', callId: 'a', arguments: {} });
  clock = 1;
  await progress.receive({ stage: 'started', toolName: 'apps_call_tool', callId: 'b', arguments: { tool: 'gmail.search_emails' } });
  clock = 2;
  await progress.receive({ stage: 'started', toolName: 'apps_call_tool', callId: 'c', arguments: { tool: 'google_drive.search' } });
  clock = 3;
  await progress.receive({ stage: 'completed', toolName: 'apps_list_tools', callId: 'a', arguments: {} });
  assert.deepEqual(sent, [activeLine('I’m checking what your connected apps can do.', 'apps_list_tools({})')]);
  assert.equal(edits.length, 0, 'edits inside the throttle window are deferred');
  await wait(80);
  assert.equal(edits.at(-1).content, ['I’ve checked your connected apps.', activeLine('I’m searching your Gmail.', 'apps_call_tool({"tool":"gmail.search_emails"})'), activeLine('I’m searching your Google Drive.', 'apps_call_tool({"tool":"google_drive.search"})')].join('\n'), 'the deferred edit catches up instead of being dropped');
  clock = 100;
  await progress.receive({ stage: 'completed', toolName: 'apps_call_tool', callId: 'c', arguments: { tool: 'google_drive.search' } });
  assert.equal(edits.at(-1).content, ['I’ve checked your connected apps.', activeLine('I’m searching your Gmail.', 'apps_call_tool({"tool":"gmail.search_emails"})'), 'I’ve searched your Google Drive.'].join('\n'), 'parallel calls of one tool are matched by call ID');
  clock = 200;
  await progress.receive({ stage: 'completed', toolName: 'apps_call_tool', callId: 'b', arguments: { tool: 'gmail.search_emails' } });
  await progress.receive({ stage: 'started', toolName: 'discord_search_messages', callId: 'd', arguments: { query: 'fate', channelIds: ['200000000000000001'] } });
  await progress.receive({ stage: 'failed', toolName: 'discord_search_messages', callId: 'd', arguments: { query: 'fate', channelIds: ['200000000000000001'] } });
  await progress.finish();
  assert.deepEqual(edits.at(-1), { content: 'I checked your connected apps, and searched your Gmail and your Google Drive. One lookup didn’t work.', options: { components: [] } });
  assert.ok(!edits.at(-1).content.includes('```'));
});

test('null or malformed tool arguments never break the progress log', async () => {
  const lines = [];
  const progress = createProgressReporter({ intervalMs: 0, send: async (content) => { lines.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { lines.push(content); } });
  for (const toolName of ['discord_search_messages', 'discord_search_batch', 'discord_read_activity', 'apps_call_tool', 'discord_user_info']) {
    await progress.receive({ stage: 'started', toolName, callId: toolName, arguments: null });
    await progress.receive({ stage: 'completed', toolName, callId: toolName, arguments: ['not', 'an', 'object'], resultCount: 2 });
  }
  assert.equal(lines.at(-1).split('\n').length, 5, 'every step still renders');
  assert.match(lines.at(-1), /^I’ve searched the server for messages and found \*2\* results\./);
  progress.close();
});

test('connected-app steps say what is being searched or read, without exposing IDs', async () => {
  const lines = [];
  const progress = createProgressReporter({ intervalMs: 0, send: async (content) => { lines.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { lines.push(content); } });
  const calls = [
    ['google_drive.search', { query: 'Q3 budget' }],
    ['google_drive.get_spreadsheet_cells', { spreadsheet_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', range: 'Sheet1!A1:F40' }],
    ['google_drive.get_document_text', { file_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345' }],
    ['gmail.read_email_thread', { thread_id: '18c2f0a9b7d6e5f4' }],
    ['github.fetch_pr_patch', { title: 'Fix fate scaling' }],
  ];
  for (const [index, [tool, input]] of calls.entries()) {
    await progress.receive({ stage: 'started', toolName: 'apps_call_tool', callId: String(index), arguments: { tool, arguments: input } });
    if (index === 0) assert.equal(lines.at(-1), activeLine('I’m searching your Google Drive for "Q3 budget".', 'apps_call_tool({"tool":"google_drive.search"})'));
    await progress.receive({ stage: 'completed', toolName: 'apps_call_tool', callId: String(index), arguments: { tool, arguments: input } });
  }
  assert.equal(lines.at(-1), [
    'I’ve searched your Google Drive for "Q3 budget".',
    'I’ve read spreadsheet cells (Sheet1!A1:F40) in your Google Drive.',
    'I’ve read a document in your Google Drive.',
    'I’ve read an email thread in your Gmail.',
    'I’ve read a PR patch "Fix fate scaling" in your GitHub.',
  ].join('\n'));
  assert.ok(!lines.join('\n').includes('1AbCdEfGh'), 'file IDs never appear');
  await progress.finish();
  assert.match(lines.at(-1), /^I searched your Google Drive for "Q3 budget", and read spreadsheet cells/);
});

test('active command traces mask credentials, escape injected fences and never expose private reasoning', async () => {
  const lines = [];
  const progress = createProgressReporter({ intervalMs: 0, send: async (content) => { lines.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { lines.push(content); } });
  const command = "curl -H 'Authorization: Bearer fixture-bearer-value' https://owner:fixture-password-value@docs.example.com/spec?token=fixture-query-value --api-key fixture-api-value\ngit status --short ``` injected";
  await progress.receive({ stage: 'started', toolName: 'task_command', callId: 'task', arguments: { command, reasoning: 'private deliberation', token: 'fixture-token-value' }, summary: 'private hidden thought', result: 'private tool output' });
  assert.equal(lines[0].split('```').length - 1, 2, 'model text cannot close the host-generated fence');
  assert.match(lines[0], /\n```\ncurl /);
  assert.ok(lines[0].includes('git status --short'), 'actual command activity remains visible');
  assert.ok(lines[0].includes('[redacted]'));
  assert.ok(!/fixture-(?:bearer|password|query|api|token)-value|private deliberation|private hidden thought|private tool output/.test(lines[0]));
  assert.ok(progress.details().every((entry) => !Object.hasOwn(entry, 'arguments') && !Object.hasOwn(entry, 'command')));
  assert.ok(!/fixture-|private hidden thought|git status/.test(JSON.stringify(progress.details())));
  await progress.receive({ stage: 'completed', toolName: 'task_command', callId: 'task', arguments: { command } });
  assert.equal(lines.at(-1), 'The coding agent finished that command.');
  await progress.finish();
  assert.equal(lines.at(-1), 'I ran the coding command.');
});

test('secret masking covers readable query summaries as well as fenced arguments', async () => {
  const lines = [];
  const progress = createProgressReporter({ intervalMs: 0, send: async (content) => { lines.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { lines.push(content); } });
  const args = { query: 'roadmap token=fixture-query-secret-value' };
  await progress.receive({ stage: 'started', toolName: 'project_search', callId: 'search', arguments: args });
  await progress.receive({ stage: 'completed', toolName: 'project_search', callId: 'search', arguments: args, resultCount: 2 });
  await progress.finish();
  assert.ok(lines[0].includes('project_search('));
  assert.ok(lines.every((line) => !line.includes('fixture-query-secret-value')));
  assert.ok(lines.every((line) => line.includes('redacted')));
  assert.ok(!lines.at(-1).includes('```'));
});

test('traces show only safe argument previews and disappear after failure or cancellation', async () => {
  for (const ending of ['failed', 'cancelled']) {
    const lines = [];
    const progress = createProgressReporter({ intervalMs: 0, send: async (content) => { lines.push(content); return { sentMessages: [{ message: { id: 'message' } }] }; }, edit: async (_, content) => { lines.push(content); } });
    await progress.receive({ stage: 'started', toolName: 'project_read_file', callId: 'file', arguments: {
      file: '/Users/owner/private-project/spec_notes.md', url: 'https://owner:fixture-password@docs.example.com/private?token=fixture-secret',
      query: 'release_criteria', token: 'fixture-token', apiKey: 'fixture-key', command: 'private-command-not-a-tool', reasoning: 'private chain of thought',
    } });
    assert.match(lines[0], /project_read_file\(\{/);
    assert.ok(lines[0].includes('spec_notes.md'), 'the filename is preserved in the fenced preview');
    assert.ok(lines[0].includes('docs.example.com'));
    assert.ok(!/Users|private-project|fixture-|private-command|chain of thought|owner:|token=/.test(lines[0]));
    if (ending === 'failed') await progress.receive({ stage: 'failed', toolName: 'project_read_file', callId: 'file', error: 'private backend credential' });
    await progress.finish({ [ending]: true });
    assert.ok(!lines.at(-1).includes('```'));
    assert.ok(!lines.at(-1).includes('private backend credential'));
    assert.match(lines.at(-1), ending === 'failed' ? /stopped before it finished/ : /Stopped this answer/);
  }
});

test('slow progress delivery coalesces hundreds of events without delaying their factual ingestion', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const lines = [];
  const progress = createProgressReporter({ intervalMs: 0,
    send: async (content) => { lines.push(content); await blocked; return { sentMessages: [{ message: { id: 'message' } }] }; },
    edit: async (_, content) => { lines.push(content); } });
  const sending = progress.receive({ stage: 'started', toolName: 'task_command', callId: 'initial', arguments: { command: 'git status --short' } });
  for (let index = 0; index < 200; index += 1) {
    void progress.receive({ stage: 'started', toolName: 'project_search', callId: String(index), arguments: { query: `query${index}` } });
    void progress.receive({ stage: 'completed', toolName: 'project_search', callId: String(index), resultCount: 2 });
  }
  assert.equal(lines.length, 1, 'only one REST mutation is active');
  assert.equal(progress.details().length, 50, 'ingestion stays current and bounded behind a slow send');
  assert.equal(progress.details().at(-1).stage, 'completed');
  release();
  await sending;
  await progress.idle();
  assert.equal(lines.length, 2, 'pending edits collapse into one latest snapshot');
  assert.match(lines.at(-1), /query199/);
  await progress.finish();
  assert.ok(!lines.at(-1).includes('```'));
});

test('finish is bounded for an uncooperative REST send and suppresses stale queued edits', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const lines = [];
  const signals = [];
  const progress = createProgressReporter({ intervalMs: 0, deliveryTimeoutMs: 40, finishTimeoutMs: 10,
    send: async (content, signal) => { lines.push(content); signals.push(signal); await blocked; return { sentMessages: [{ message: { id: 'message' } }] }; },
    edit: async (_, content) => { lines.push(content); } });
  void progress.receive({ stage: 'started', toolName: 'project_search' });
  void progress.receive({ stage: 'completed', toolName: 'project_search', resultCount: 1 });
  const startedAt = Date.now();
  await progress.finish({ cancelled: true });
  assert.ok(Date.now() - startedAt < 200, 'finish cannot wait forever for ignored cancellation');
  assert.equal(signals[0].aborted, true);
  release();
  await wait(5);
  await progress.receive({ stage: 'started', toolName: 'discord_list_servers' });
  assert.equal(lines.length, 1, 'nothing edits a late receipt after the queue timed out');
});
