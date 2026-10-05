import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createT3Client } from '../src/proactive/t3-client.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nova-t3-client-'));
  await mkdir(join(root, 'userdata'));
  const filename = join(root, 'session.json');
  await writeFile(filename, JSON.stringify({ token: 'private-credential', baseDirectory: root, expiresAt: new Date(Date.now() + 60000).toISOString() }), { mode: 0o600 });
  await writeFile(join(root, 'userdata', 'server-runtime.json'), JSON.stringify({ origin: options.origin || 'http://127.0.0.1:3773' }));
  const sent = []; const fetched = []; const socketUrls = [];
  class Socket extends EventEmitter {
    readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    send(text) {
      const message = JSON.parse(text); sent.push(message);
      if (message._tag === 'Request' && !options.silent) queueMicrotask(() => {
        if (message.tag === 'orchestration.subscribeShell') this.emit('message', JSON.stringify({ _tag: 'Chunk', requestId: message.id, values: [{ kind: 'snapshot', snapshot: { projects: [{ id: 'project' }] } }] }));
        else if (!message.tag.includes('subscribe')) this.emit('message', JSON.stringify({ _tag: 'Exit', requestId: message.id, exit: { _tag: 'Success', value: { confirmed: true } } }));
      });
    }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const client = createT3Client({ filename, timeoutMs: 50,
    fetchImplementation: async (url, configuration) => { fetched.push({ url, configuration }); return { ok: true, json: async () => ({ ticket: 'single-use-ticket' }) }; },
    socketFactory: (url) => { socketUrls.push(url); return new Socket(); },
  });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  return { client, sent, fetched, socketUrls, filename };
}

test('T3 uses dedicated bearer only for ticket issuance and ticket only for websocket', async (t) => {
  const { client, fetched, socketUrls, sent } = await fixture(t);
  assert.deepEqual(await client.request('server.getConfig'), { confirmed: true });
  assert.equal(fetched[0].configuration.headers.Authorization, 'Bearer private-credential');
  assert.equal(fetched[0].configuration.redirect, 'error');
  assert.equal(socketUrls[0].includes('private-credential'), false);
  assert.equal(socketUrls[0].includes('wsTicket=single-use-ticket'), true);
  assert.equal(sent[0].tag, 'server.getConfig');
});

test('T3 refuses public runtime origins before sending credentials', async (t) => {
  const { client, fetched } = await fixture(t, { origin: 'http://example.com:3773' });
  await assert.rejects(client.request('server.getConfig'), /loopback/);
  assert.equal(fetched.length, 0);
});

test('T3 rejects group-readable credential files before authenticating', async (t) => {
  const { client, fetched, filename } = await fixture(t);
  await chmod(filename, 0o644);
  await assert.rejects(client.request('server.getConfig'), /owner-readable/);
  assert.equal(fetched.length, 0);
});

test('project catalog cancels its stream and acknowledges streamed snapshots', async (t) => {
  const { client, sent } = await fixture(t);
  assert.deepEqual(await client.projects(), [{ id: 'project' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.some((value) => value._tag === 'Interrupt'), true);
  assert.equal(sent.some((value) => value._tag === 'Ack'), true);
});

test('unconfirmed T3 mutations time out without a replay', async (t) => {
  const { client, sent } = await fixture(t, { silent: true });
  await assert.rejects(client.request('orchestration.launchThread', { commandId: 'stable-id' }), /timed out/);
  assert.equal(sent.filter((value) => value._tag === 'Request').length, 1);
});
