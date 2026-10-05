import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

function processAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId < 1) return false;
  try { process.kill(processId, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function acquireScheduleLease(filename) {
  const lease = `${filename}.lock`;
  const identity = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lease, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, identity })); } finally { await handle.close(); }
      return async () => {
        let existing;
        try { existing = JSON.parse(await readFile(lease, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (existing.identity === identity) await unlink(lease);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(await readFile(lease, 'utf8')); } catch (readError) { if (readError.code === 'ENOENT') continue; throw new Error('State lease is incomplete; another process may be opening it'); }
      if (processAlive(existing.pid)) throw new Error('State is already owned by another listener');
      const recoveryName = `${lease}.recovery`;
      let recovery;
      try {
        recovery = await open(recoveryName, 'wx', 0o600);
        const current = JSON.parse(await readFile(lease, 'utf8'));
        if (processAlive(current.pid)) throw new Error('State is already owned by another listener');
        await unlink(lease);
      } catch (recoveryError) {
        if (!['ENOENT', 'EEXIST'].includes(recoveryError.code)) throw recoveryError;
        if (recoveryError.code === 'EEXIST') throw new Error('Another process is recovering this state');
      } finally { if (recovery) { await recovery.close(); await unlink(recoveryName).catch(() => {}); } }
    }
  }
  throw new Error('Unable to acquire state ownership');
}
