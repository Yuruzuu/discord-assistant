import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  if (Number(process.versions.node.split('.')[0]) < 22 || typeof process.loadEnvFile !== 'function') {
    throw new Error('The Discord plugin requires Node.js 22 or newer.');
  }

  const configurationRoot = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const credentialsFile = process.env.DISCORD_ENV_FILE || join(configurationRoot, 'discord-mcp', '.env');
  if (existsSync(credentialsFile)) {
    process.loadEnvFile(credentialsFile);
  } else if (process.env.DISCORD_ENV_FILE) {
    throw new Error('DISCORD_ENV_FILE does not point to an existing credentials file.');
  }

  const runtimeUrl = new URL('../runtime/server.cjs', import.meta.url);
  if (!existsSync(fileURLToPath(runtimeUrl))) throw new Error('The Discord plugin runtime is missing. Build the plugin and reinstall it.');
  process.env.DISCORD_PROACTIVE_ENTRYPOINT ||= fileURLToPath(new URL('../runtime/proactive.cjs', import.meta.url));
  process.env.DISCORD_INSTRUCTIONS_DIR ||= fileURLToPath(new URL('../runtime/instructions', import.meta.url));

  await import(runtimeUrl.href);
} catch (error) {
  process.stderr.write(`[discord-plugin] ${error.message}\n`);
  process.exitCode = 1;
}
