import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const excluded = new Set(['.git', 'node_modules', '.env', '.codex', '.ssh']);
function contains(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }
export function createProjectReader(roots = []) {
  const projects = roots.map((entry, index) => typeof entry === 'string' ? { id: String(index + 1), root: entry } : entry);
  async function locate(projectId, relativePath = '') {
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) throw new Error('Project is not in the explicitly approved project list');
    if (relativePath.split(/[\\/]/).some((part) => excluded.has(part) || (part.startsWith('.') && part !== '..' && part !== '.'))) throw new Error('Private or generated project files are unavailable');
    const root = await realpath(project.root);
    const target = await realpath(path.resolve(root, relativePath));
    if (!contains(root, target)) throw new Error('Path escapes the approved project root');
    return { root, target };
  }
  async function read({ projectId, file, startLine = 1, limit = 200 }) {
    const { target } = await locate(projectId, file);
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('Choose a text file smaller than 1 MiB');
    const text = await readFile(target, 'utf8');
    if (text.includes('\0')) throw new Error('Binary files are unavailable');
    const lines = text.split('\n');
    return { projectId, file, startLine, totalLines: lines.length, text: lines.slice(startLine - 1, startLine - 1 + limit).join('\n'), nextLine: startLine - 1 + limit < lines.length ? startLine + limit : null, untrustedContent: true };
  }
  async function search({ projectId, query, limit = 40 }, signal) {
    const { root } = await locate(projectId);
    const needle = query.toLowerCase();
    const matches = []; let visited = 0; let truncated = false;
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted();
        if (excluded.has(entry.name) || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        if (++visited > 3000 || matches.length >= limit) { truncated = true; return; }
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile()) {
          const resolved = await realpath(target); if (!contains(root, resolved)) continue;
          const info = await stat(resolved); if (info.size > 256 * 1024) continue;
          const text = await readFile(resolved, 'utf8'); if (text.includes('\0')) continue;
          const lines = text.split('\n');
          for (let index = 0; index < lines.length && matches.length < limit; index += 1) if (lines[index].toLowerCase().includes(needle)) matches.push({ file: path.relative(root, target), line: index + 1, text: lines[index].slice(0, 500) });
        }
      }
    }
    await walk(root);
    return { projectId, matches, visited, truncated, untrustedContent: true };
  }
  return { list: () => ({ projects: projects.map(({ id, root, name }) => ({ id, name: name || path.basename(root) })) }), read, search };
}
