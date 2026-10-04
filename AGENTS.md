# AGENTS.md

Orientation for coding agents working in this repository. Read this first, then
open the specific doc in [`agents/`](agents/README.md) for the area you are
touching.

## What this repo is

A Node.js (ESM, Node ≥ 22 for the plugin) **Discord MCP server** plus **Nova**, an
owner-only proactive Discord bot.

- **MCP server** (`index.mjs` → `src/server.mjs`): stdio MCP tools for Claude Code
  and Codex to read servers, channels, tickets, messages, images and profiles,
  and to send messages, replies, reactions and forwards as a bot.
- **Nova** (`src/proactive/`): detached background listener processes. They
  watch Discord over the Gateway and answer the fixed owner using the logged-in
  **Codex CLI** (`codex app-server`) as the model runtime, with scoped read-only
  tools.
- **Plugin** (`plugins/discord/`): Claude/Codex plugin wrapper. Its `runtime/`
  folder is an esbuild bundle generated from `src/`, and it is gitignored.

## Commands

```bash
npm test                 # builds the plugin first (pretest), then node --test
node --test test/forwarding.test.mjs   # one file (does not rebuild the plugin)
npm run build:plugin     # regenerate plugins/discord/runtime, .mcp.json, .codex-plugin/
npm start                # run the stdio MCP server (needs DISCORD_TOKEN or accounts config)
```

Tests mock Discord REST and the Codex app-server, so they need no tokens or
network.

## Repo map

```
index.mjs                  MCP entrypoint (loads config, builds DiscordService, runs stdio server)
src/
  server.mjs               MCP tool registrations (the public tool contract)
  service.mjs              DiscordService: multi-account routing, discovery, reads, images
  discord-api.mjs          DiscordApiClient: REST, rate limits, retries, concurrency
  messaging.mjs            send / reply / batch / forward helpers
  shapes.mjs               raw Discord JSON → stable output shapes
  search.mjs, message-browser.mjs, users.mjs, reactions.mjs, discord-url.mjs, config.mjs
  tool-results.mjs         register(), success(), failure(), annotations
  proactive/               Nova: controller, supervisor, daemon, gateway, engine, Codex turn, sender…
plugins/discord/           plugin manifest sources (plugin.json, mcp.json), launcher, skill, generated runtime
scripts/build-plugin.mjs   esbuild bundle + generated manifests + third-party notices
test/                      node:test suites (one per area) + helpers/codex-app-server.mjs
agents/                    detailed docs for agents (catalog below)
```

## Docs catalog (`agents/`)

| Doc | Read when you are… |
| --- | --- |
| [architecture.md](agents/architecture.md) | getting oriented: processes, layers, data flow, module map |
| [features.md](agents/features.md) | finding where a user-visible feature lives (modules + tests) |
| [tools.md](agents/tools.md) | changing or adding an MCP tool or a Nova worker tool |
| [nova-pipeline.md](agents/nova-pipeline.md) | touching how Nova receives, thinks, and replies |
| [security-invariants.md](agents/security-invariants.md) | changing anything about access, scope, sending, or files (**must read**) |
| [configuration-and-state.md](agents/configuration-and-state.md) | dealing with env vars, credentials, on-disk state |
| [testing.md](agents/testing.md) | writing or debugging tests |
| [playbooks.md](agents/playbooks.md) | doing a common change: new tool, new Nova reply action, release |

## Rules that must not break

These are summarised here. The full list is in
[security-invariants.md](agents/security-invariants.md).

1. **Owner-only Nova.** Only `directMessageOwnerId` (`src/proactive/target.mjs`)
   can trigger replies or controls. Never widen this.
2. **Nova's reading scope.** Server conversations read only their own server.
   The owner DM may read any server the bot can see. Other users' DMs are never
   readable. The same check (`read-tools.mjs`) applies to anything Nova forwards.
3. **Nova never writes on its own.** The model returns a JSON *reply plan*. The
   host validates it (`reply-validation.mjs`) and only then sends. Worker tools
   are read-only. Posting outside the current conversation (`channelMessages`)
   is owner-DM-only, limited to server text channels, blocked after
   connected-app reads, and confirmed back to the owner.
4. **No duplicate sends.** Every send uses a nonce with `enforce_nonce`. Nova
   journals deliveries (`delivery-journal.mjs`). Failed sends are never retried
   automatically after an unknown outcome.
5. **Mentions are off by default** (`allowed_mentions.parse: []`).
6. **Tokens never leak.** Redact them from errors. The Codex worker gets a
   filtered environment (`worker-environment.mjs`).
7. **The public tool contract is stable.** Keep tool names, input schemas and
   output shapes backward compatible. Tool-count tests (`stdio`, `plugin`,
   `read-tool-registry`) intentionally fail when the set changes, so update them
   deliberately.

## Code conventions

- ESM `.mjs`, no TypeScript, no build step for `src/` (only the plugin is bundled).
- Validation uses `zod/v4` at tool boundaries and plain asserts
  (`assertSnowflake`) inside helpers. Helpers re-validate, because Nova calls them
  directly without going through MCP.
- Dense, compact style: long single-line expressions, few comments, and factory
  functions (`createX(...)`) that return closures rather than classes. The
  exceptions are `DiscordService` and `DiscordApiClient`. Match the surrounding
  density.
- Comments explain *why* (constraints, Discord quirks), never *what*.
- Dependencies are injected (`fetchImpl`, `spawnImpl`, `sleep`, `now`, `signal`)
  so tests can fake them. Keep that pattern for any I/O you add.
- Thread `AbortSignal` through async work, and call `signal?.throwIfAborted()`
  before side effects.
- Reuse the shared helpers instead of copying them: `writeFileAtomic` and
  `writeState` (`proactive/state.mjs`) for private files, `assertSnowflake`,
  `validateCursors` and `compareSnowflakes` (`discord-url.mjs`), and
  `batchIdFor` inside `reply-sender.mjs`.
- Errors from sends carry `nonce`, `sendStatus` (`rejected` | `unknown`) and,
  for batches, `batchId`, `sentMessages` and `failedMessageIndex`.
  `tool-results.failure()` surfaces these fields.
- The version string lives in several places. See the release checklist in
  [playbooks.md](agents/playbooks.md#release).
