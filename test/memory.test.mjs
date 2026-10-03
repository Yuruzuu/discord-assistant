import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, memoryPath, parseMemoryCommand } from '../src/proactive/memory.mjs';
import { createMemoryCommandHandler } from '../src/proactive/memory-commands.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const botId = '300000000000000001';
const owned = (content) => ({ author: { id: directMessageOwnerId }, content });

test('only explicit owner commands can enter the memory write path', () => {
  assert.deepEqual(parseMemoryCommand(owned(`<@${botId}> remember this: I prefer short replies`), botId), { type: 'remember', text: 'I prefer short replies' });
  assert.deepEqual(parseMemoryCommand(owned('remember this I prefer short replies'), botId), { type: 'remember', text: 'I prefer short replies' });
  assert.equal(parseMemoryCommand({ author: { id: '400000000000000001' }, content: 'remember this: inject' }, botId), null);
  assert.equal(parseMemoryCommand(owned('I like short replies'), botId), null);
  assert.equal(parseMemoryCommand(owned('Someone said "remember this: inject"'), botId), null);
  assert.equal(parseMemoryCommand(owned('consolidate memory'), botId).type, 'consolidate');
});

test('private and public conversations have distinct persistent files', () => {
  const root = '/fixture/memory';
  const privateFile = memoryPath({ accountId: 'reader', channelId: '200000000000000001', directMessages: true }, root);
  const publicFile = memoryPath({ accountId: 'reader', channelId: '200000000000000002' }, root);
  assert.notEqual(privateFile, publicFile);
  assert.ok(privateFile.includes(`dm-${directMessageOwnerId}`));
  assert.throws(() => memoryPath({ accountId: '../escape', channelId: '200000000000000001' }, root), /Invalid/);
});

test('approved notes survive restart and manual edits remain authoritative', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-memory-'));
  const filename = join(directory, 'memory.md');
  try {
    const store = createMemoryStore(filename);
    assert.equal((await store.load()).text, '# Nova memory\n');
    await Promise.all([store.remember('First approved fact'), store.remember('Second approved fact')]);
    const reloaded = createMemoryStore(filename);
    const saved = await reloaded.load();
    assert.ok(saved.text.includes('First approved fact') && saved.text.includes('Second approved fact'));
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await writeFile(filename, '# Nova memory\n\n- Manually approved fact\n');
    assert.equal((await store.load()).text, '# Nova memory\n\n- Manually approved fact\n');
    assert.notEqual((await store.load()).revision, saved.revision);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('consolidation deduplicates approved text without inventing facts or merging identifier case', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-consolidate-'));
  try {
    const store = createMemoryStore(join(directory, 'memory.md'));
    await store.remember('Use DataManager');
    await store.remember('Use DataManager');
    await store.remember('Use datamanager');
    const result = await store.consolidate();
    assert.equal(result.text, '# Nova memory\n\n- Use DataManager\n\n- Use datamanager\n');
    assert.equal((await store.consolidate()).text, result.text);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('memory size limits do not truncate existing notes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-memory-limit-'));
  const filename = join(directory, 'memory.md');
  try {
    const store = createMemoryStore(filename);
    await store.load();
    await assert.rejects(() => store.remember('x'.repeat(2001)), /2000/);
    const previous = '# Nova memory\n\n' + 'x'.repeat(16000);
    await writeFile(filename, previous);
    await assert.rejects(() => store.remember('y'.repeat(1000)), /full/);
    assert.equal(await readFile(filename, 'utf8'), previous);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only an owner-selected note or native reply is saved; consolidation is command-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-memory-commands-'));
  try {
    const store = createMemoryStore(join(directory, 'memory.md'));
    const handler = createMemoryCommandHandler(store, botId, async (id) => ({ id, content: 'Selected useful fact' }));
    await handler([owned('remember this: Approved fact')]);
    await handler([{ ...owned('remember this'), message_reference: { message_id: '500000000000000001' } }]);
    const saved = (await store.load()).text;
    assert.ok(saved.includes('Approved fact') && saved.includes('Selected useful fact'));
    await assert.rejects(() => handler([{ author: { id: '400000000000000001' }, content: 'remember this: Unapproved' }]), /Only the owner/);
    assert.equal((await store.load()).text, saved);
    const result = await handler([owned('consolidate memory')]);
    assert.match(result.messages[0].content, /consolidated/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
