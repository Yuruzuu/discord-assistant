import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Prompts live as Markdown in /instructions so they can be edited without touching code; the bundled plugin points DISCORD_INSTRUCTIONS_DIR at its copy.
export function instructionsRoot() {
  return process.env.DISCORD_INSTRUCTIONS_DIR || (typeof __dirname === 'string' ? join(__dirname, 'instructions') : fileURLToPath(new URL('../instructions/', import.meta.url)));
}

function render(text, variables, file) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{\s*([A-Za-z]\w*)\s*\}\}/g, (match, name) => {
      if (!Object.hasOwn(variables, name)) throw new Error(`Unknown placeholder {{${name}}} in ${file}`);
      return String(variables[name]);
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A file name loads that file; a folder name loads its .md files in name order, skipping README.md and files starting with "_".
export function loadInstructions(name, variables = {}, root = instructionsRoot()) {
  const path = join(root, name);
  let files;
  try {
    files = statSync(path).isDirectory()
      ? readdirSync(path).filter((file) => file.endsWith('.md') && !file.startsWith('_') && file.toLowerCase() !== 'readme.md').sort().map((file) => join(path, file))
      : [path];
  } catch (error) {
    throw new Error(`Instructions "${name}" were not found in ${root}. Set DISCORD_INSTRUCTIONS_DIR or rebuild the plugin. (${error.code || error.message})`);
  }
  const text = files.map((file) => render(readFileSync(file, 'utf8'), variables, file)).filter(Boolean).join('\n\n');
  if (!text) throw new Error(`Instructions "${name}" in ${root} are empty`);
  return text;
}
