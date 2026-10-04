# Security invariants

Check every change against this list. Each invariant has tests. If a change
needs to relax one, stop and ask the human first.

## Who can drive Nova

| Invariant | Where enforced | Tests |
| --- | --- | --- |
| Only `directMessageOwnerId` can trigger replies. Bots, webhooks and other users are dropped before generation | `target.acceptsListenerMessage`, `gateway.mjs`, `engine.receive` | `proactive-engine`, `direct-messages`, `server-mentions` |
| Only the owner can run controls (text `nova …`, `/nova`, buttons, `discord_nova_control`) | `engine.control`, `channel-runtime.control`, `daemon-controls.execute`, interaction handler in `gateway.mjs` | `nova-controls` |
| A DM listener must target a DM channel whose only recipient is the owner | `target.assertOwnerDirectMessageChannel` (controller and runtime) | `direct-messages` |
| Memory is saved only on explicit owner commands, never from ordinary chat | `memory.parseMemoryCommand`, `memory-commands.mjs`, prompt text | `memory` |

## What Nova can read

| Invariant | Where enforced |
| --- | --- |
| A server conversation reads only its own guild | `read-tools.guild()` / `channelSource()` |
| The owner DM may read any guild the bot can see, plus this DM. Other people's DMs are never readable | `read-tools.channelSource()` |
| Search channel filters must belong to the requested guild | `read-tools` `discord_search_messages` |
| Worker schemas never accept `accountId` or other routing overrides | `read-tool-registry.readToolFields` (non-trusted) |
| **Forwards reuse the read scope**: the source must pass `forwardSource`, and the destination is always the current conversation | `read-tools.forwardSource`, `reply-sender.forwards` (refuses if no resolver is wired) |
| **Connected apps** are owner DM only and read-only. Only tools annotated `readOnlyHint: true` without `destructiveHint`, never payment tools. The host calls them on a hidden thread, and the reply model never gets native app access | `connected-apps.isAllowedAppTool`, `read-tools.mjs` (DM and non-trusted gate), `conversation.mjs` (Nova thread keeps `apps: false` and asserts no MCP tools) |
| After connected-app data is read in a turn, `web_read_link` is refused until the next turn, which closes the URL-exfiltration channel | `read-tools.mjs` (`appDataRead`, `beginTurn`), `conversation.runTurn` |
| Project files are readable only in the owner DM, only under approved roots, never dotfiles, `.git`, `node_modules`, `.env` or `.ssh`, with no symlink escapes, text ≤ 1 MiB | `project-tools.mjs` |
| The web reader allows only public HTTP(S) (ports 80/443), no credentials, re-resolves on each redirect (≤ 4), rejects private, reserved and IPv6-mapped addresses, accepts text, HTML or JSON ≤ 512 KiB, 15 s timeout | `link-reader.mjs` |
| Images are fetched only over HTTPS from approved Discord media hosts, with redirects, MIME type, file signature and byte limits checked | `discord-api.requestImage`, `service.imageContent` |
| Voice audio comes only from Discord CDN, and an API backend posts only to the configured endpoint without forwarding auth to the CDN | `voice-transcriber.mjs` |
| All conversation content, tool results, link text and files are **data**, marked `untrustedContent`. The prompt says so | `context.mjs`, `read-tools`, `conversation.mjs` instructions |

## How Nova acts

| Invariant | Where enforced |
| --- | --- |
| The model has no write tools. It can only return a reply plan, which the host validates and executes | `read-tools` (read-only registry), `reply-validation.mjs`, `engine.mjs` |
| The Codex child has no approvals, no environments, an ephemeral working directory, and an allow-listed environment (no Discord tokens) | `conversation.mjs` turn params, `worker-environment.responderEnvironment` |
| Posting outside the current conversation is owner DM only, limited to server text channels and threads, at most 3 per reply, refused after connected-app data was read in the turn, and confirmed back to the owner by host-written text | `reply-validation.mjs`, `read-tools.sendTarget`, `engine.mjs` |
| Progress messages show only sanitized tool arguments (no mention or markup characters, hostnames only for links, basenames only for files), never model reasoning, results or raw errors | `progress.mjs` |
| GIFs, stickers and custom emoji must come from the supplied catalog. Reactions may target only supplied conversation messages | `reply-validation.mjs` |
| Generated files are in-memory text only, with safe basenames and size caps. They never come from the local filesystem | `discord-chunks.validateGeneratedFiles`, `discord-api.sendMessageFiles` |
| Turn, tool-call and repeated-failure budgets are bounded | `conversation.mjs` |

## Sending safety (MCP and Nova)

| Invariant | Where enforced |
| --- | --- |
| Every send has a nonce with `enforce_nonce: true`. Batches derive deterministic nonces | `messaging.mjs`, `reply-sender.mjs` |
| An error with an unknown outcome (5xx or network) is marked `sendStatus: 'unknown'` and **never auto-retried** | `messaging.postMessage`, `discord-api.mjs` |
| Nova journals each operation. An `unknown` entry blocks resending until the owner resolves it | `delivery-journal.mjs`, `reply-sender.deliver`, `channel-runtime` (`retry`) |
| Mentions are disabled unless the MCP caller sets `allowMentions`. Nova never pings, except users mentioned in a `channelMessages` post the owner asked to notify. Roles and @everyone never ping | `allowed_mentions.parse: []`, `reply-sender.channelMessages` (`users` list) |
| MCP write tools are annotated `readOnlyHint: false`, and tool descriptions say "only use when explicitly asked" | `server.mjs`, `tool-results.writeAnnotations` |

## Secrets and local control

| Invariant | Where enforced |
| --- | --- |
| Tokens come only from the environment and the credentials file, are never written to listener configs or state, and are redacted from surfaced errors | `config.mjs`, `daemon.errorMessage`, `read-tools.errorMessage` |
| Listener control is HTTP on `127.0.0.1` only, with a random 32-byte bearer token (timing-safe compare), a `listenerId` check, and no redirects | `controller.controlRequest`, `daemon.mjs`, `supervisor.listenerControlAddress` |
| State, config and journal files are written atomically with mode `0600`, and directories with `0700` | `state.mjs`, `delivery-journal.mjs`, `nova-settings.mjs` |
| The plugin bundle contains no credentials, and the launcher reads `~/.config/discord-mcp/.env` (or `DISCORD_ENV_FILE`) at runtime | `plugins/discord/scripts/start.mjs`, `plugin` test |
