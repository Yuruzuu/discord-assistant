export function responderEnvironment(source = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SYSTEMROOT', 'SystemRoot', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'].includes(name) || name.startsWith('LC_')) {
      environment[name] = value;
    }
  }
  return environment;
}
