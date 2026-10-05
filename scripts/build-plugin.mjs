import { build } from 'esbuild';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

// Each bundled file belongs to the package after its last node_modules segment, so nested copies keep their own version and license,
// and builds from a worktree (whose dependencies resolve from a parent folder) still find every package.
const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const segments = input.split('/');
  const index = segments.lastIndexOf('node_modules');
  if (index === -1 || index + 1 >= segments.length) continue;
  packageRoots.add(resolve(repositoryRoot, segments.slice(0, index + (segments[index + 1].startsWith('@') ? 3 : 2)).join('/')));
}
const packages = new Map();
for (const packageRoot of packageRoots) {
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const key = `${metadata.name}@${metadata.version}`;
  if (!packages.has(key)) packages.set(key, { metadata, packageRoot });
}
const notices = [];
for (const [, { metadata, packageRoot }] of [...packages].sort(([left], [right]) => left.localeCompare(right))) {
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
  if (!licenseText) throw new Error(`Missing license text for bundled dependency ${metadata.name}`);
  notices.push(`${metadata.name} ${metadata.version}\n${licenseText.trim()}`);
}
await writeFile(join(runtimeRoot, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n---\n\n') + '\n');

process.stdout.write(`Built Discord plugin with ${packages.size} bundled dependencies.\n`);
