import { createHash } from 'node:crypto';

const snapshotFields = ['expressions', 'allowedGifUrls', 'approvedMemory', 'botName', 'serverName', 'channelName', 'ownerTimeZone'];
const revisionOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// Snapshot state belongs to one native conversation. Only a completed turn can advance it.
export function createContextProjector() {
  let snapshots = new Map();
  let generation = 0;

  function prepare(context) {
    const preparedGeneration = generation;
    const next = new Map(snapshots);
    let input = { ...context };
    const fullInput = { ...context };
    const revisions = {};
    const changed = [];
    const cleared = [];
    for (const field of snapshotFields) {
      const present = Object.hasOwn(context, field) && context[field] !== undefined;
      if (!present && !snapshots.has(field)) continue;
      const value = present ? context[field] : null;
      const revision = revisionOf(value);
      if (snapshots.get(field) === revision) {
        if (Buffer.byteLength(JSON.stringify(value)) > Buffer.byteLength(JSON.stringify(revision))) {
          revisions[field] = revision;
          delete input[field];
        }
      }
      else {
        input[field] = value;
        fullInput[field] = value;
        changed.push(field);
        if (snapshots.has(field) && (!present || value === null || value === '' || (Array.isArray(value) && !value.length))) cleared.push(field);
      }
      next.set(field, revision);
    }
    if (Object.keys(revisions).length || cleared.length) input.contextSnapshots = {
      ...(Object.keys(revisions).length ? { revisions } : {}),
      ...(changed.length ? { changed } : {}), ...(cleared.length ? { cleared } : {}),
    };
    if (cleared.length) fullInput.contextSnapshots = { cleared };
    // Tiny snapshots cost less to resend than revision metadata. The base prompt owns replacement semantics.
    if (Buffer.byteLength(JSON.stringify(input)) >= Buffer.byteLength(JSON.stringify(fullInput))) input = fullInput;
    const originalBytes = Buffer.byteLength(JSON.stringify(context));
    const projectedBytes = Buffer.byteLength(JSON.stringify(input));
    let committed = false;
    return {
      input,
      // This is a conservative byte-based estimate, not a tokenizer measurement.
      metrics: { originalBytes, projectedBytes, estimatedTokens: Math.ceil(projectedBytes / 3), snapshotBytesSaved: Math.max(0, originalBytes - projectedBytes) },
      commit() {
        if (committed || generation !== preparedGeneration) return false;
        committed = true;
        snapshots = next;
        generation += 1;
        return true;
      },
    };
  }

  return { prepare, reset() { snapshots = new Map(); generation += 1; } };
}
