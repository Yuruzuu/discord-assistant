# Playbooks

Step-by-step recipes for common changes. Each recipe ends with the docs and
tests to update.

## Add an MCP tool

1. **Logic.** Put the logic in a domain module (`messaging.mjs`, `service.mjs`,
   …), not in `server.mjs`. Accept `(service, args, { signal, sleep } = {})`.
   Re-validate inputs with `assertSnowflake` etc., because Nova or other
   callers may skip zod.
2. **Registration.** Register it in `src/server.mjs` with `register(server,
   name, { title, description, inputSchema, annotations }, handler)`.
   - Write tools: `annotations: writeAnnotations`, and say "Only use when
     explicitly asked" in the description.
   - Return `success(structured, extraContent?)`. Throw errors; `register`
     converts them.
   - For sends, generate a nonce (or derive one from `batchId`) and set
     `enforce_nonce`. On failure set `error.nonce` and `error.sendStatus` (see
     `messaging.postMessage`).
3. **Shared read tool?** If Nova should have it too, add its schema to
   `read-tool-registry.mjs` (`sharedFields`, plus `readToolFields` narrowing
   for the worker) and its implementation to `executeSharedReadTool`. Wrap it
   with scope checks in `read-tools.mjs`.
4. **Tests.** Add a focused test file or extend the area suite. Update the
   tripwires: the write list in `stdio.test.mjs`, and the counts in
   `plugin.test.mjs` and `read-tool-registry.test.mjs`.
5. **Docs.** Update the README tool table and its "exposes N MCP tools" count, the guidance in
   `plugins/discord/skills/use-discord/SKILL.md`, the server `instructions` in
   `server.mjs` (if it changes how agents should choose tools),
   [tools.md](tools.md) and [features.md](features.md).

## Add a Nova reply-plan action

Use the `forwards` field as the reference implementation.

1. **Schema and prompt** (`reply-style.mjs`): add the property to `replySchema`
   and to `required` (the Codex output schema requires every key). Describe when
   to use it in `replyStyle`. Add a host-behaviour sentence to the
   `instructions` in `conversation.mjs` ("the host validates and executes…;
   don't claim success early").
2. **Streaming allow-list** (`reply-stream.mjs`): add the key to the
   allowed-keys array, or every turn will abort.
3. **Validation** (`reply-validation.mjs`): add a strict zod schema with a
   `.default([])`. Dedupe the items, validate them against `context` where
   possible, and drop them when `shouldReply` is false (if the action counts as
   a reply). Allow a reply that contains only this action if that makes sense.
4. **Execution** (`reply-sender.mjs`): add `send.<action>`.
   - Resolve the target with `resolve(trigger)`.
   - Use `deliver(operationId, operation, metadata)` with a unique operation ID
     and a short nonce suffix (25-character limit). This makes it idempotent
     across restarts.
   - Do any async scope checks through an injected resolver (wired from
     `channel-runtime.mjs`), and make the default refuse.
   - Attach `batchId`, `sentMessages` and `failedMessageIndex` to errors.
5. **Ordering** (`engine.processBatch`): call it in the right place relative to
   reactions, bubbles and files. Add a statistics counter and add it to
   `sentMessages` where appropriate.
6. **Security.** Confirm it still satisfies
   [security-invariants.md](security-invariants.md). Nova may only act in the
   current conversation, within its read scope.
7. **Tests.** Cover validation (accept, dedupe, drop), the stream allow-list,
   the sender (nonce, journal, scope refusal) and engine ordering. See
   `test/forwarding.test.mjs`.
8. **Docs.** Update [nova-pipeline.md](nova-pipeline.md) (plan table, nonce
   table, delivery order) and [features.md](features.md).

## Add a Nova worker read tool

1. In `read-tools.mjs`, call `register(name, description, fields, execute)`.
   `execute(args, signal)` must call the scope helpers first (`guild(guildId)`
   or `channelSource(args)`).
2. Return plain JSON. Large results are paged automatically. Mark external
   content with `untrustedContent: true`.
3. Gate it behind a `nova.json` toggle if it reaches outside Discord (see
   `web`, `playbooks`, `projectRoots`).
4. The MCP server auto-registers it too, unless it's in `existingReads`. Update
   the tool counts.
5. Add tests to `proactive-read-tools.test.mjs`: the in-scope success case and
   the out-of-scope rejection.

## Add a `nova` control action

1. **Parsing** (`controls.mjs`): add it to `parseNovaCommand` (and to
   `simpleActions` if it takes no value) and to the `/nova` slash command
   options.
2. **Engine** (`engine.mjs`): add the action to the explicit-control regex if
   it must work mid-turn. Then handle it in `engine.control`,
   `channel-runtime.control` (conversation-level) or `daemon-controls.execute`
   (cross-conversation: jobs, digests).
3. **MCP enum** (`tools.mjs`): add it to the `discord_nova_control` action enum.
4. Check that it's owner-gated (every handler checks `userId ===
   directMessageOwnerId`).
5. Add tests in `nova-controls.test.mjs`.

## Release

The version string appears in all of these places. Bump them together:

- `package.json` and `package-lock.json` (two occurrences at the top)
- `plugins/discord/plugin.json`
- `src/server.mjs` (`McpServer` version)
- `src/proactive/codex-pool.mjs` (`clientInfo.version` in `initialize`)
- `README.md` (the "Version X.Y.Z exposes N MCP tools" line; keep the tool count right too)
- `plugins/discord/.codex-plugin/plugin.json` is regenerated by
  `npm run build:plugin`

Then run `npm test` (it rebuilds the plugin) and `npm pack --dry-run`. Commit as
`chore: release Discord plugin X.Y.Z`. Feature commits use the
`feat:` / `fix:` / `chore:` prefixes.
