# Architecture

## Processes

```
 Claude Code / Codex (MCP client)
        │ stdio (JSON-RPC)
        ▼
┌──────────────────────────────┐        spawn (detached)        ┌──────────────────────┐
│ MCP server                   │ ─────────────────────────────▶ │ supervisor.mjs       │
│ index.mjs → src/server.mjs   │                                │ restarts w/ backoff, │
│  • read/send tools           │   HTTP 127.0.0.1 + bearer      │ stops on fatal auth  │
│  • proactive tools ──────────┼──── /status /control /stop ──┐ └─────────┬────────────┘
│    (controller.mjs)          │                              │           │ spawn
└──────────────────────────────┘                              │           ▼
                                                              │ ┌──────────────────────────────┐
                                                              └▶│ daemon.mjs (one per listener)│
                                                                │  • control HTTP server       │
                                                                │  • gateway.mjs (discord.js)  │
                                                                │  • channel-runtime / server- │
                                                                │    mentions → engine → sender│
                                                                └─────────────┬────────────────┘
                                                                              │ stdio JSON-RPC
                                                                              ▼
                                                                ┌──────────────────────────────┐
                                                                │ codex app-server (Codex CLI) │
                                                                │ pooled per command+env       │
                                                                │ (codex-pool.mjs)             │
                                                                └──────────────────────────────┘
```

- **MCP server**: a short-lived, client-owned process. It holds no Nova state
  except what it reads from disk and asks the daemons over HTTP.
- **Controller** (`proactive/controller.mjs`, runs inside the MCP server and
  inside daemons for cross-listener controls). It checks that the Codex CLI is
  installed and logged in, writes the listener configuration (mode 0600)
  including a random `controlToken`, then spawns `supervisor → daemon` detached.
  It talks to daemons only via `http://127.0.0.1:<port>` with
  `Authorization: Bearer <controlToken>` and checks the `listenerId` in each
  response.
- **Supervisor** (`proactive/supervisor.mjs`): restarts the daemon with
  exponential backoff (up to 5 restarts). It gives up on fatal failures (invalid
  token, disallowed intents; see `isFatalListenerFailure`), and the
  `.supervision.json` sidecar toggles it.
- **Daemon** (`proactive/daemon.mjs`): one per listener *target*. It loads only
  the listener's account and opens the Gateway. It registers the `/nova` slash
  command, recovers pending deliveries, and serves the control HTTP endpoints.
- **Codex app-server**: the model runtime. Nova sends turns with an
  `outputSchema` (the reply plan). Read tools are offered as dynamic tools,
  answered by the daemon (`onToolCall` → `readTools.call`).

### Listener targets

| Target | Started by | Scope | Runtime shape |
| --- | --- | --- | --- |
| Channel | `discord_start_proactive` | one server text channel or thread | one `createChannelRuntime` |
| Owner DMs | `discord_start_direct_messages` | the owner's DM channel, mode `all` | one `createChannelRuntime`, plus the digest manager |
| All servers | `discord_start_server_mentions` | every channel the bot can see, mentions only | `createServerMentions` lazily creates one runtime per channel (LRU, max 8 idle); shared `createReplyScheduler`; research jobs |

Channel listeners and the all-servers listener for the same account are mutually
exclusive (`assertNoOverlappingListener`).

## Layers inside the MCP server

```
server.mjs                    tool schemas (zod) + register()/success()/failure()
  ├─ messaging.mjs            send / reply / batch / forward  ─┐
  ├─ reactions.mjs                                             │
  ├─ search.mjs, message-browser.mjs, users.mjs                ├─ DiscordService (service.mjs)
  ├─ proactive/read-tool-registry.mjs (shared read schemas)    │    multi-account routing,
  ├─ proactive/read-tools.mjs (Nova-only extras also exposed)  │    discovery cache, images
  └─ proactive/tools.mjs → controller.mjs                     ─┘        │
                                                                         ▼
                                                              DiscordApiClient (discord-api.mjs)
                                                              REST v10, rate-limit buckets,
                                                              retries, 4 concurrent req/bot,
                                                              in-flight GET de-duplication
shapes.mjs  raw Discord JSON → stable output (shapeMessage, shapeChannel, …)
```

- **`DiscordService`** routes each request to a bot account that can access the
  guild or channel (`resolveGuild` and `resolveChannel` remember the winning
  account), and runs server discovery across accounts. `normalizeReadSource`
  turns a URL or IDs into `{guildId, channelId, messageId}`.
- **`DiscordApiClient`**: all HTTP goes through `requestJson`/`scheduleRequest`,
  which honour Discord bucket headers and global cooldowns. Failed sends are
  never retried after a connection error.
- **Shared read tools.** Several read tools have one schema and implementation
  shared by MCP and Nova (`read-tool-registry.mjs`). MCP gets the "trusted local"
  field set. Nova's worker gets a narrower set (`readToolFields(name, scope)`).

## Nova inside a daemon

```
gateway.mjs ──MessageCreate──▶ channel-runtime.receive ──▶ engine.receive
                                                        │  (owner gate, mode, batching, queue, cooldown)
                                                        ▼
                    context.mjs (+ context-media: images, voice) + memory snapshot
                                                        ▼
                    conversation.mjs runTurn → Codex turn (outputSchema = replySchema)
                         │  dynamic tool calls → read-tools.call (scope-checked)
                         │  streamed JSON → reply-stream.mjs → validator.message → engine.onMessage → sender
                         ▼
                    validator.plan (reply-validation.mjs)
                         ▼
engine: reactions → bubbles → files → forwards → buttons? ──▶ reply-sender.mjs ──▶ messaging.mjs
                                                              (delivery-journal: nonce + receipts)
```

See [nova-pipeline.md](nova-pipeline.md) for the detailed lifecycle.

## Module map

### `src/`

| Module | Responsibility |
| --- | --- |
| `config.mjs` | Parse `DISCORD_TOKEN` / `DISCORD_ACCOUNTS_JSON` / `DISCORD_ACCOUNTS_FILE` and image limits |
| `service.mjs` | `DiscordService`: accounts, discovery, routing, `read`, `listChannels`, `listTickets`, images, attachments, access checks, legacy aliases |
| `discord-api.mjs` | `DiscordApiClient` REST wrapper and `DiscordApiError` |
| `server.mjs` | MCP tool registration (the public contract) |
| `tool-results.mjs` | `register` (wraps handlers, so errors become `failure()`), `success`, annotations |
| `messaging.mjs` | `sendMessage`, `sendResolvedMessage`, `sendMessageBatch`, `forwardMessages`, `forwardResolvedMessage`, `listExpressions` |
| `reactions.mjs` | Emoji normalisation and `addReaction` |
| `search.mjs` | Paged guild message search (≤ 250 results; pages after the first fetched three at a time) and `searchMessagesBatch` |
| `activity.mjs` | `readServerActivity`: date-window channel-history reader for recent activity and day summaries, plus time-zone and day-boundary helpers |
| `message-browser.mjs` | Context and browse windows with older/newer cursors |
| `users.mjs` | Profile and member info |
| `shapes.mjs` | Output shaping, including forwarded snapshots (`forwardedFrom`, `forwarded`) |
| `discord-url.mjs` | Snowflake checks, URL parsing, `validateCursors`, `compareSnowflakes`, snowflake timestamps |
| `concurrency.mjs` | `createConcurrencyLimit`, `mapConcurrent` |
| `instructions.mjs` | Loads the Markdown prompts in `/instructions` (`DISCORD_INSTRUCTIONS_DIR` overrides the location) |

### `src/proactive/`

| Module | Responsibility |
| --- | --- |
| `tools.mjs` | MCP tools for starting, stopping and inspecting listeners, and `discord_nova_control` |
| `controller.mjs` | Spawn, stop, status and control listeners. Codex CLI detection. Locks |
| `supervisor.mjs` | Restart loop for daemons |
| `daemon.mjs` | Listener process main: control server, gateway, runtimes, jobs, digests |
| `daemon-controls.mjs` | Routes owner control requests to the right runtime, job manager or digest manager |
| `state.mjs`, `state-writer.mjs` | Listener file paths, `writeFileAtomic` (temp file, mode 0600, rename, cleanup on failure), `writeState`, throttled status writer |
| `gateway.mjs`, `gateway-strategy.mjs`, `gateway-sdk.cjs` | discord.js Gateway client, reconnects, message normalisation to REST-like shape |
| `target.mjs` | **`directMessageOwnerId`**, listener acceptance, mention and reply detection, DM ownership assert |
| `channel-runtime.mjs` | Wires one conversation: settings, memory, journal, read tools, responder, engine, sender, controls, recovery |
| `server-mentions.mjs` | Lazy per-channel runtimes for the all-servers listener, thread binding |
| `engine.mjs` | Trigger policy, batching, queue, cooldown, turn processing, in-conversation `nova …` controls |
| `reply-scheduler.mjs` | Shared, serialised cooldown and rate limit across conversations |
| `context.mjs`, `context-media.mjs` | Build model input: trigger, recent and reply messages, expressions, GIFs, images, voice transcripts, forwarded snapshots |
| `conversation.mjs` (`codex-responder.mjs` re-exports) | Codex thread lifecycle, turn execution, tool-call budget, streaming, steer, compact, reset, diagnostics |
| `codex-pool.mjs`, `app-server.mjs` | Pooled `codex app-server` child over JSON-RPC |
| `worker-environment.mjs` | Allow-listed environment for the Codex child |
| `reply-style.mjs`, `reply-defaults.mjs` | Reply-plan JSON schema; default model, effort and tier (the persona prompt lives in `instructions/nova/`) |
| `reply-stream.mjs` | Incremental JSON parser that emits complete `messages[]` bubbles while the model streams |
| `reply-validation.mjs` | Validates bubbles and the final plan (catalogs, targets, limits, dedupe) |
| `reply-sender.mjs` | Delivers bubbles, progress, files, reactions, forwards, opt-in owner buttons and status reactions via the journal |
| `delivery-journal.mjs` | Per-channel durable record of ingress and send operations and receipts (7-day retention) |
| `discord-chunks.mjs` | Splits long text safely (keeps code fences), validates generated files |
| `progress.mjs`, `typing.mjs` | Tool-activity progress messages, typing indicator |
| `read-tools.mjs` | Nova's scope-checked read-only tool set (+ `forwardSource`) and result paging |
| `read-tool-registry.mjs` | Shared schemas and implementations for read tools used by both MCP and Nova |
| `connected-apps.mjs` | Read-only bridge to the owner's Codex/ChatGPT connected apps through a hidden apps-enabled Codex thread (`mcpServer/tool/call`) |
| `link-reader.mjs` | Public-only web reader (blocks private addresses and credentials) |
| `project-tools.mjs` | Read-only access to approved project roots (owner DM only) |
| `memory.mjs`, `memory-commands.mjs` | Owner-approved per-conversation memory file and commands |
| `nova-settings.mjs` | `~/.config/discord-mcp/nova.json` (project roots, voice, per-conversation overrides, feature toggles) |
| `controls.mjs` | `nova …` text command parser, `/nova` slash command, control buttons |
| `research-jobs.mjs` | Owner research jobs in new public threads (all-servers listener) |
| `digests.mjs` | Opted-in periodic search digests delivered to the owner DM |
| `voice-transcriber.mjs` | Voice-note transcription (local whisper or explicit API endpoint) |
