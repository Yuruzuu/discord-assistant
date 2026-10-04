#!/usr/bin/env node
import { loadConfig } from './src/config.mjs';
import { runStdioServer } from './src/server.mjs';
import { DiscordService } from './src/service.mjs';
import { fileURLToPath } from 'node:url';
import { createNovaSettings } from './src/proactive/nova-settings.mjs';

async function main() {
  const config = loadConfig();
  const service = new DiscordService({
    ...config,
    proactiveEntrypoint: process.env.DISCORD_PROACTIVE_ENTRYPOINT || fileURLToPath(new URL('./src/proactive/daemon.mjs', import.meta.url)),
  });
  await runStdioServer(service, { novaOptions: await createNovaSettings().load() });
  process.stderr.write(`[discord-readonly] v2 started with ${config.accounts.length} account(s)\n`);
}

main().catch((error) => {
  process.stderr.write(`[discord-readonly] startup failed: ${error.message}\n`);
  process.exit(1);
});
