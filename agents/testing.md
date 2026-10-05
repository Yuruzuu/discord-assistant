# Testing

## Running

```bash
npm test                                  # pretest builds the plugin, then node --test (all test/*.test.mjs)
node --test test/forwarding.test.mjs      # single file, skips the plugin build
node --test --test-name-pattern "forward" # filter by test name
```

- The tests use `node:test` and `node:assert/strict`, with no other framework
  and no network or tokens.
- `test/plugin.test.mjs` runs the **built** bundle from an isolated temp folder.
  If you changed `src/` and run that file alone, run `npm run build:plugin`
  first.
- Worktrees under `.claude/worktrees/` live inside the repo. Run tests from the
  checkout you mean to test.

## Fakes and fixtures

| Need | Pattern | Example |
| --- | --- | --- |
| Discord REST end to end | `new DiscordService({ accounts: [{ id, token: 'mock-token' }], fetchImpl })`, where `fetchImpl` routes on `new URL(input).pathname.replace('/api/v10','')` and returns `new Response(JSON.stringify(…))` | `messaging.test.mjs`, `forwarding.test.mjs` |
| MCP over the wire | `InMemoryTransport.createLinkedPair()` + `Client` from the SDK, then `client.listTools()` / `client.callTool()` | `read-tool-registry.test.mjs`, `forwarding.test.mjs` |
| Real stdio process | spawn `index.mjs` with `StdioClientTransport` | `stdio.test.mjs` |
| Lightweight service stub | a plain object with `resolveChannel`, `resolveGuild`, `normalizeReadSource`, `accounts` | `proactive-read-tools.test.mjs`, `reply-sender.test.mjs` |
| Codex app-server | `fakeCodexServer({ plans, tools, toolCalls, events, … })` from `test/helpers/codex-app-server.mjs`, which returns a `spawnImpl` that speaks the JSON-RPC protocol | `codex-responder.test.mjs`, `proactive-read-tools.test.mjs` |
| Engine | `createProactiveEngine({ getContext, generateReply, sendReplies, batchWindowMs: 5, cooldownMs: 0, … })`, where `sendReplies` is a function with optional `.react`, `.files`, `.forwards`, `.progress`, `.statusReaction` | `proactive-engine.test.mjs` |
| Time and sleep | inject `now`, `sleep` (e.g. `async (ms) => sleeps.push(ms)`) | `messaging`, `proactive-supervisor` |
| File state | temp directories via `mkdtemp(join(tmpdir(), …))`, and pass `root` / `filename` options | `delivery-journal`, `memory`, `proactive-controller` |

The owner ID for fixtures is `directMessageOwnerId` from
`src/proactive/target.mjs`. Snowflakes in fixtures are 18-digit strings such as
`'200000000000000001'`.

## Suite map

| Area | Files |
| --- | --- |
| Config, URL, concurrency, prompts | `config`, `discord-url`, `concurrency`, `instructions` |
| REST client and resilience | `discord-api`, `network-recovery`, `request-optimization` |
| Service and reading | `service`, `server`, `search-browser`, `search-batch`, `activity`, `read-tool-registry` |
| Sending | `messaging`, `replies-users`, `reactions`, `forwarding`, `channel-messages` |
| MCP surface and packaging | `stdio`, `plugin` |
| Nova engine and replies | `proactive-engine`, `reply-stream`, `reply-sender`, `reply-controls`, `discord-experience`, `proactive-progress`, `typing` |
| Nova Codex integration | `app-server`, `codex-responder`, `codex-runtime-controls`, `web-search`, `instructions` |
| Nova tools and context | `proactive-read-tools`, `proactive-context-tools`, `connected-apps`, `voice-transcriber` |
| Nova runtime and listeners | `channel-runtime-integration`, `direct-messages`, `server-mentions`, `gateway-recovery` |
| Nova control plane | `proactive-controller`, `proactive-supervisor`, `nova-controls`, `state-writer` |
| Nova persistence and jobs | `delivery-journal`, `memory`, `research-jobs`, `proactive-digests` |

## Intentional tripwires

- **Tool count and write-tool list.** `stdio.test.mjs` asserts the exact ordered
  list of write tools. `plugin.test.mjs` and `read-tool-registry.test.mjs`
  assert the total tool count. Update them whenever you add or remove a tool.
- **Reply plan keys.** `reply-stream.mjs` rejects unknown top-level keys. Tests
  that stream plans must include every required key in `replySchema.required`.
- **Native reply payloads.** Some tests `deepEqual` the exact
  `message_reference`. Keep reply payloads (no `type`) separate from forward
  payloads (`type: 1`).
