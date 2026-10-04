import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createDeliveryJournal } from '../src/proactive/delivery-journal.mjs';
import { directMessageOwnerId } from '../src/proactive/target.mjs';

const accountId = 'default';
const channelId = '200000000000000001';
const guildId = '200000000000000002';
const messageId = '300000000000000001';
const receipt = { accountId, nonce: 'nonce:1', message: { id: '400000000000000001', channelId, guildId, content: 'private conversation', attachments: [{ content: 'private file' }], url: 'https://example.com/?token=secret' }, token: 'credential', accountEmail: 'private@example.com' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nova-delivery-'));
  let clock = 1000;
  const options = { accountId, channelId, root, now: () => clock };
  const journal = await createDeliveryJournal(options);
  return { root, options, journal, setClock: (value) => { clock = value; }, close: async () => { await journal.close(); await rm(root, { recursive: true, force: true }); } };
}

test('confirmed receipts keep only routing IDs and nonces, with atomic private persistence', async () => {
  const data = await fixture();
  try {
    await data.journal.begin('op:1', { nonce: 'nonce:1', triggerMessageId: messageId, content: 'never retain', token: 'credential' });
    await data.journal.record('op:1', receipt);
    const entry = await data.journal.lookup('op:1');
    assert.equal(entry.status, 'sent');
    assert.deepEqual(entry.receipt.message, { id: receipt.message.id, channelId, guildId, url: `https://discord.com/channels/${guildId}/${channelId}/${receipt.message.id}` });
    const filename = join(data.root, `${accountId}-${channelId}.json`);
    const stored = await readFile(filename, 'utf8');
    for (const secret of ['private conversation', 'private file', 'credential', 'private@example.com', 'never retain', 'example.com']) assert.ok(!stored.includes(secret));
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.equal((await stat(data.root)).mode & 0o777, 0o700);
    entry.receipt.message.id = 'changed';
    assert.equal((await data.journal.lookup('op:1')).receipt.message.id, receipt.message.id);
    await assert.rejects(data.journal.record('foreign', { message: { id: receipt.message.id, channelId: guildId } }), /different channel/);
  } finally { await data.close(); }
});

test('pending operations become unknown after restart and cannot be sent until explicitly resolved', async () => {
  const data = await fixture();
  let restored;
  try {
    await data.journal.begin('op:pending', { nonce: 'nonce:1', triggerMessageId: messageId });
    await data.journal.close();
    restored = await createDeliveryJournal(data.options);
    assert.equal((await restored.lookup('op:pending')).status, 'unknown');
    await assert.rejects(restored.begin('op:pending'), /uncertain/);
    await restored.resolve('op:pending', { delivered: false });
    assert.equal((await restored.lookup('op:pending')).status, 'rejected');
    await restored.begin('op:pending', { nonce: 'nonce:1' });
    await restored.unknown('op:pending', { token: 'secret' });
    await assert.rejects(restored.resolve('op:pending', { delivered: true }), /receipt/);
    await restored.resolve('op:pending', { delivered: true, receipt });
    assert.equal((await restored.lookup('op:pending')).status, 'sent');
  } finally { await restored?.close(); await data.close(); }
});

test('owner ingress claims deduplicate messages and unfinished ingress can be recovered without storing chat text', async () => {
  const data = await fixture();
  let restored;
  try {
    const metadata = { id: messageId, authorId: directMessageOwnerId, channel_id: channelId, guild_id: guildId, content: 'private text', token: 'credential' };
    assert.equal((await data.journal.claimIngress(metadata)).claimed, true);
    assert.equal((await data.journal.claimIngress(metadata)).claimed, false);
    await assert.rejects(data.journal.claimIngress({ ...metadata, id: '300000000000000002', authorId: '500000000000000001' }), /Only owner/);
    await data.journal.close();
    restored = await createDeliveryJournal(data.options);
    const pending = await restored.pendingIngress();
    assert.equal(pending[0].status, 'pending');
    assert.equal(pending[0].messageId, messageId);
    assert.ok(!JSON.stringify(pending).includes('private text'));
    await restored.finishIngress(messageId, 'sent');
    assert.deepEqual(await restored.pendingIngress(), []);
    assert.equal((await restored.claimIngress(metadata)).claimed, false);
  } finally { await restored?.close(); await data.close(); }
});

test('same-process journal users share serialized state and closing one lease does not close another', async () => {
  const data = await fixture();
  let shared;
  try {
    shared = await createDeliveryJournal(data.options);
    const claims = await Promise.all([data.journal.claimIngress({ id: messageId, authorId: directMessageOwnerId }), shared.claimIngress({ id: messageId, authorId: directMessageOwnerId })]);
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    await data.journal.close();
    await shared.record('op:still-open', receipt);
    assert.equal((await shared.lookup('op:still-open')).status, 'sent');
    await assert.rejects(data.journal.lookup('op:still-open'), /closed/);
  } finally { await shared?.close(); await data.close(); }
});

test('another process cannot take an active journal lease and a stale lease can be recovered', async () => {
  const data = await fixture();
  try {
    const moduleUrl = new URL('../src/proactive/delivery-journal.mjs', import.meta.url).href;
    const code = `import {createDeliveryJournal} from ${JSON.stringify(moduleUrl)}; try { await createDeliveryJournal(${JSON.stringify({ accountId, channelId, root: data.root })}); process.exit(2); } catch(error) { process.stdout.write(error.message); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    const exitCode = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(exitCode, 0);
    assert.match(output, /another process/);
    await data.journal.close();
    await writeFile(join(data.root, `${accountId}-${channelId}.json.lock`), JSON.stringify({ pid: 2147483647, identity: 'stale' }));
    const recovered = await createDeliveryJournal(data.options);
    await recovered.close();
  } finally { await data.close(); }
});

test('retention prunes old terminal records while preserving unknown deliveries and unfinished ingress', async () => {
  const data = await fixture();
  try {
    await data.journal.record('old:sent', receipt);
    await data.journal.unknown('old:unknown', { nonce: 'nonce:1' });
    await data.journal.claimIngress({ id: messageId, ownerUserId: directMessageOwnerId });
    data.setClock(8 * 24 * 60 * 60 * 1000);
    await data.journal.record('new:sent', receipt);
    assert.equal(await data.journal.lookup('old:sent'), null);
    assert.equal((await data.journal.lookup('old:unknown')).status, 'unknown');
    assert.equal((await data.journal.pendingIngress()).length, 1);
  } finally { await data.close(); }
});
