import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function isolatedEnvironment(credentialsFile) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('DISCORD_')) delete environment[name];
  }
  environment.DISCORD_ENV_FILE = credentialsFile;

  return environment;
}

async function pluginFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await pluginFiles(path));
    else files.push(path);
  }

  return files;
}

test('installed plugin runs from an isolated folder without repository dependencies or bundled credentials', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'discord-plugin-test-'));
  const pluginRoot = join(temporary, 'discord');
  const credentialsFile = join(temporary, 'credentials.env');
  const client = new Client({ name: 'discord-plugin-test', version: '1.0.0' });
  try {
    await cp(new URL('../plugins/discord', import.meta.url), pluginRoot, { recursive: true });
    await writeFile(credentialsFile, 'DISCORD_TOKEN=mock-plugin-token\n', { mode: 0o600 });
    const files = await pluginFiles(pluginRoot);
    assert.ok(files.every((path) => !path.includes('node_modules') && !/(?:^|\/)\.env(?:\.|$)/.test(path)));

    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(pluginRoot, 'scripts', 'start.mjs')],
      cwd: temporary,
      env: isolatedEnvironment(credentialsFile),
      stderr: 'pipe',
    }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 24);
    assert.ok(tools.some((tool) => tool.name === 'discord_read'));
    assert.ok(tools.some((tool) => tool.name === 'discord_send_message' && tool.annotations.readOnlyHint === false));
    assert.ok(tools.some((tool) => tool.name === 'discord_list_expressions'));
    assert.ok(tools.some((tool) => tool.name === 'discord_start_proactive'));
    assert.ok(tools.some((tool) => tool.name === 'discord_search_messages'));
    assert.ok(tools.some((tool) => tool.name === 'discord_message_context'));
    const directMessages = tools.find((tool) => tool.name === 'discord_start_direct_messages');
    assert.ok(directMessages);
    assert.equal(directMessages.annotations.readOnlyHint, false);
    assert.ok(!('userId' in directMessages.inputSchema.properties));
    assert.ok(!('ownerUserId' in directMessages.inputSchema.properties));
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('missing explicit credentials file produces an actionable startup error', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'discord-plugin-error-'));
  try {
    const result = spawnSync(process.execPath, ['plugins/discord/scripts/start.mjs'], {
      env: isolatedEnvironment(join(temporary, 'missing.env')),
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DISCORD_ENV_FILE does not point to an existing credentials file/);
    assert.equal(result.stdout, '');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
