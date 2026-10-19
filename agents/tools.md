# Tool catalog

There are two tool surfaces:

1. **MCP tools.** These are registered in `src/server.mjs` (plus
   `src/proactive/tools.mjs`) for Claude Code and Codex. They are trusted local
   callers.
2. **Nova worker tools** (`src/proactive/read-tools.mjs`). These are offered to
   the Codex model during a Nova turn. They are read-only and scope-checked.

All MCP handlers go through `register()` in `tool-results.mjs`. A thrown error
becomes an `isError` result with structured `error` fields: `nonce` and
`sendStatus` for sends, and `batchId`, `sentMessages` and `failedMessageIndex`
for batches. Tools are read-only by default (`readOnlyHint: true`), and write
tools spread `writeAnnotations`.

## MCP tools (45)

R = read-only, W = write. The **Schema** column says where the input schema is
defined.

### Discovery and reading

| Tool | R/W | Implementation | Schema |
| --- | --- | --- | --- |
| `discord_list_servers` | R | `service.listServers` via `executeSharedReadTool` | `read-tool-registry` |
| `discord_list_channels` | R | `service.listChannels` | `read-tool-registry` |
| `discord_list_tickets` | R | `service.listTickets` | `server.mjs` |
| `discord_read` | R | `service.read` (images as MCP image content) | `server.mjs` |
| `discord_search_messages` | R | `search.mjs` `searchMessages` | `read-tool-registry` |
| `discord_read_activity` | R | `activity.mjs` `readServerActivity`: date-window history reader (skip idle channels by `last_message_id`, parallel `after=` paging, archived-thread discovery, compact transcripts, keyword filter, 10-minute cache, 20 s deadline) | `read-tool-registry` (registered from `read-tools`) |
| `discord_search_batch` | R | `search.mjs` `searchMessagesBatch`: ≤ 10 variants in one call, one 25-result page each, deduped compact hits (requests on the search route are sequential) | `read-tool-registry` (registered from `read-tools`) |
| `discord_message_context` | R | `message-browser.mjs` (anchor required) | `read-tool-registry` |
| `discord_browse_messages` | R | `message-browser.mjs` `browseMessages` | `read-tool-registry` |
| `discord_fetch_attachment` | R | `service.fetchAttachment` (Discord CDN image hosts only) | `server.mjs` |
| `discord_read_pdf` | R | `read-tools` scoped attachment resolution, `pdf-reader` isolated extraction | `read-tools` |
| `discord_check_access` | R | `service.checkAccess` | `server.mjs` |
| `discord_list_expressions` | R | `messaging.listExpressions` | `server.mjs` |
| `discord_user_info` | R | `users.getUserInfo` | `read-tool-registry` |
| `discord_find_members` | R | registry inline (`searchGuildMembers`) | `read-tool-registry` (registered from `read-tools`) |
| `web_read_link` | R | `link-reader.readPublicLink` | `read-tools` |
| `discord_research_topic` | R | `read-tools` playbook (search + context reads) | `read-tools` |
| `read_tool_result` | R | `read-tools` stored-result pager | `read-tools` |
| `project_list` / `project_search` / `project_read_file` | R | `project-tools.mjs`. **Only present when `nova.json` has `projectRoots`** | `read-tools` |

The MCP server registers every `read-tools` tool not already defined in
`server.mjs` (see the `existingReads` set). This is why tool counts change when
`nova.json` has project roots.

### Writing

| Tool | Implementation | Notes |
| --- | --- | --- |
| `discord_send_message` | `messaging.sendMessage` | ≤ 2000 chars, ≤ 3 stickers, `gifUrl`, `embeds` ≤ 10 and link `buttons` ≤ 25 (`rich-messages.mjs`, HTTPS only), optional native reply, `nonce` |
| `discord_reply` | `messaging.sendMessage` with `replyToMessageId` | reply ping off unless `mentionRepliedUser` |
| `discord_send_messages` | `messaging.sendMessageBatch` | 1–5 bubbles, `intervalMs`, `batchId` → nonces `<batchId>:<i>` |
| `discord_forward_messages` | `messaging.forwardMessages` | 1–10 native forwards (URL or channel and message IDs), in order, nonces `<batchId>:f<i>`. A forward carries no text |
| `discord_add_reaction` | `reactions.addReaction` | Unicode or custom emoji, idempotent |
| `discord_create_channel` / `discord_create_category` | `guild-admin.createChannel` / `createCategory` | Needs Manage Channels. POST, never retried; 5xx or network failures say the outcome is unknown. Optional audit-log `reason` |
| `discord_create_role` | `guild-admin.createRole` | Needs Manage Roles. Permissions are a decimal bitfield string; `color` is an integer or `#RRGGBB` |
| `discord_add_role` / `discord_remove_role` | `guild-admin.addMemberRole` / `removeMemberRole` | Idempotent PUT/DELETE. Refuses the @everyone role |
| `discord_create_emoji` / `discord_create_sticker` | `expression-uploads.createEmoji` / `createSticker` | Needs Create Expressions. Exactly one of `filePath` (absolute local path or `~`) or `imageUrl` (Discord CDN only, via `fetchImage`). Extension, size and file signature checked before upload. Emoji: PNG/JPEG/GIF/WebP ≤ 256 KiB, JSON data URI. Sticker: PNG/APNG/GIF ≤ 512 KiB, multipart; `tags` default to the name. POST, never retried |
| `discord_import_expressions` | `expression-uploads.importExpressionFolder` | Non-recursive folder import (no dotfiles), file-name order, ≤ 50 per call, names from files. `skipExisting` (default) makes re-runs safe; `dryRun` previews. Per-file rejections continue; 403, full slots (30008/30039) and unknown outcomes stop. Returns `created`/`wouldCreate`, `skipped`, `failed`, `notAttempted` |

The administration tools are MCP-only (trusted local callers); Nova's reply plan cannot create channels or roles. Nova can upload emojis and stickers from the owner DM through its own `expressionUploads` reply action (see [nova-pipeline.md](nova-pipeline.md)).

### Nova lifecycle (`src/proactive/tools.mjs` → `controller.mjs`)

| Tool | R/W | Purpose |
| --- | --- | --- |
| `discord_start_proactive` / `discord_stop_proactive` / `discord_proactive_status` | W / W / R | One channel listener |
| `discord_start_direct_messages` / `discord_stop_direct_messages` / `discord_direct_message_status` | W / W / R | Owner DM listener |
| `discord_start_server_mentions` / `discord_stop_server_mentions` / `discord_server_mentions_status` | W / W / R | All-servers owner-mention listener |
| `discord_nova_control` | W | Owner controls (status, stop, pause, model, research, digest, deliveries, …) forwarded to a daemon over HTTP |

### Legacy aliases (v1 compatibility, keep)

`discord_get_message`, `discord_read_messages`, `discord_get_channel`,
`discord_get_server_info` map to `service.legacy*`.

## Nova worker tools

These are built per conversation by
`createDiscordReadTools(service, scope, settings)`. `scope` is
`{ channelId, guildId, directMessages }`. The MCP server passes
`{ trustedLocal: true, directMessages: true }`, which skips scope checks and
exposes the full field sets.

| Tool | Server conversation | Owner DM |
| --- | --- | --- |
| `discord_list_servers` | own server only (filtered) | all servers |
| `discord_list_channels`, `discord_find_members`, `discord_search_messages`, `discord_search_batch`, `discord_read_activity`, `discord_user_info`, `discord_research_topic` | own guild only | any guild |
| `discord_message_context`, `discord_browse_messages` | channels in own guild | any guild channel + this owner DM |
| `web_read_link` | if `settings.web !== false` | same |
| `project_list` / `project_search` / `project_read_file` | never | if `projectRoots` configured |
| `local_list_images` | never | any folder on the owner's computer, one level: subfolders plus image names, sizes and emoji/sticker fit, never contents. Not on MCP. Off with `localFiles: false`. Closes `web_read_link` for the rest of the turn |
| `apps_list_tools` / `apps_call_tool` | never | read-only connected-app calls; `access: action` discovers separately approved actions |
| `apps_prepare_action` | never | exact immutable write proposal, separate owner approval |
| `nova_list_schedules` / `nova_prepare_reminder` / `nova_prepare_alert` | never | inspect schedules or prepare separately approved creations |
| `nova_handoff_catalog` / `nova_list_tasks` / `nova_prepare_handoff` | never | T3 project/provider catalog, own task status, separately approved task launch |
| `read_tool_result` | always | always |

Worker schemas are narrower than MCP schemas (`readToolFields(name, scope)`): no
`accountId`, smaller search limits, and a required `guildId` for user info.
Results larger than `maxResultBytes` (128 KiB by default) are truncated and
paged through `read_tool_result` handles (10-minute expiry, 8 kept).

**Connected apps** (`connected-apps.mjs`). These tools are owner DM only and
never registered on the MCP surface. The host calls `mcpServer/tool/call` on
the `codex_apps` server of a hidden, apps-enabled Codex thread that never runs a
model turn, so the reply model never gets native app access.
`isAllowedAppTool` permits only `readOnlyHint: true` tools that aren't marked
`destructiveHint`, and refuses payment-related names (`paypal`, `invoice`,
`billing`, …). After `apps_call_tool` runs, `web_read_link` refuses for the rest
of the turn (`readTools.beginTurn()` resets it each turn). Images in app results
(PNG, JPEG, WebP or GIF) are kept host-side as per-turn handles (`img1`…, at
most 12). The model may list them in the reply plan's `images`, and the sender
uploads them through `sendMessageImages` (≤ 4, 8 MiB each, 20 MiB total). Live
screenshots of web UIs are not supported.

`readTools.forwardSource({channelId, messageId})`, `readTools.sendTarget(channelId)` and `readTools.expressionTarget(guildId)` are **not** model tools. `sendTarget` gates `channelMessages`: owner DM only, server text channels and threads only, refused after connected-app reads in the turn. `expressionTarget` gates `expressionUploads` the same way (owner DM only, any server the bot can see, refused after connected-app reads). The
reply sender uses it to scope-check Nova's planned forwards with the same rules.

## Changing a tool

- Changing the set of tools breaks the `test/stdio.test.mjs` write-tool list and
  the counts in `test/plugin.test.mjs` and `test/read-tool-registry.test.mjs` on
  purpose. Update them.
- Shared read tools must stay compatible for **both** surfaces. Check
  `readToolFields` for the worker narrowing.
- Update the README tool table, `plugins/discord/skills/use-discord/SKILL.md`,
  and the server `instructions` string in `server.mjs` if usage guidance
  changes.
- See [playbooks.md](playbooks.md#add-an-mcp-tool).
