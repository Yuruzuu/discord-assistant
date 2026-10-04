import { build } from 'esbuild';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = join(repositoryRoot, 'plugins', 'discord');
const runtimeRoot = join(pluginRoot, 'runtime');

await mkdir(runtimeRoot, { recursive: true });
const result = await build({
  absWorkingDir: repositoryRoot,
  entryPoints: { server: 'index.mjs', proactive: 'src/proactive/daemon.mjs', supervisor: 'src/proactive/supervisor.mjs' },
  outdir: runtimeRoot,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  metafile: true,
  legalComments: 'eof',
  logLevel: 'silent',
});

const manifest = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8'));
const mcp = JSON.parse(await readFile(join(pluginRoot, 'mcp.json'), 'utf8'));
for (const [name, server] of Object.entries(mcp.mcpServers)) {
  if (server.type !== 'stdio') continue;
  const unsupported = Object.keys(server).filter((key) => !['type', 'command', 'args', 'env', 'cwd'].includes(key));
  if (unsupported.length) throw new Error(`Plugin stdio server ${name} contains unsupported fields: ${unsupported.join(', ')}`);
}
await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  author: manifest.author,
  repository: manifest.repository,
  license: manifest.license,
  skills: './skills/',
  mcpServers: './.mcp.json',
  interface: manifest.extensions['com.openai'].interface,
}, null, 2) + '\n');
await writeFile(join(pluginRoot, '.mcp.json'), JSON.stringify({
  mcpServers: Object.fromEntries(Object.entries(mcp.mcpServers).map(([name, server]) => {
    const { type, ...configuration } = server;
    return [name, configuration];
  })),
}, null, 2) + '\n');
await copyFile(join(repositoryRoot, 'LICENSE'), join(pluginRoot, 'LICENSE'));
await rm(join(runtimeRoot, 'instructions'), { recursive: true, force: true });
await cp(join(repositoryRoot, 'instructions'), join(runtimeRoot, 'instructions'), { recursive: true });

const packages = new Set(Object.keys(result.metafile.inputs)
  .filter((path) => path.startsWith('node_modules/'))
  .map((path) => {
    const segments = path.split('/').slice(1);
    return segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  }));
const notices = [];
for (const name of [...packages].sort()) {
  const packageRoot = join(repositoryRoot, 'node_modules', name);
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  let licenseText;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'license', 'license.md', 'license.txt']) {
    try {
      licenseText = await readFile(join(packageRoot, filename), 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!licenseText && metadata.repository?.url === 'git+https://github.com/sapphiredev/utilities.git') {
    licenseText = await readFile(join(repositoryRoot, 'scripts', 'third-party-licenses', 'sapphire-utilities.txt'), 'utf8');
  }
  if (!licenseText) throw new Error(`Missing license text for bundled dependency ${name}`);
  notices.push(`${metadata.name} ${metadata.version}\n${licenseText.trim()}`);
}
await writeFile(join(runtimeRoot, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n---\n\n') + '\n');

process.stdout.write(`Built Discord plugin with ${packages.size} bundled dependencies.\n`);
