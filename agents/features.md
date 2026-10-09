# Feature catalog

Each feature lists its entry points, the modules that implement it, and the
tests that cover it. Tool details are in [tools.md](tools.md).

## MCP (Claude Code / Codex driven)

| Feature | Entry points | Modules | Tests |
| --- | --- | --- | --- |
| Multi-account bots and discovery | all tools; `discord_list_servers` | `config.mjs`, `service.mjs` (`discoverServers`, `resolveGuild`, `resolveChannel`) | `config`, `service`, `network-recovery` |
| Channel tree and tickets | `discord_list_channels`, `discord_list_tickets` | `service.mjs` (`listChannels`, `listTickets`) | `service`, `request-optimization` |
| Read by URL or IDs (with images) | `discord_read`, legacy aliases | `service.mjs` (`read`, `imageContent`), `shapes.mjs` | `service`, `server` |
| **Recent activity and day summaries** | `discord_read_activity` (`day`, `hours`, `since/until`, `keywords`, `channelIds`) | `activity.mjs`, `discord-api.listArchivedThreads` (`archivedAfter`) | `activity` |
| Search and context browsing | `discord_search_messages`, `discord_search_batch`, `discord_message_context`, `discord_browse_messages` | `search.mjs`, `message-browser.mjs`, `read-tool-registry.mjs` | `search-browser`, `search-batch`, `read-tool-registry` |
| Image fetch | `discord_fetch_attachment` | `service.mjs` (`fetchAttachment`), `discord-api.mjs` (`fetchImage`) | `service`, `discord-api` |
| Access diagnostics | `discord_check_access` | `service.mjs` (`checkAccess`) | `service` |
| Profiles and members | `discord_user_info`, `discord_find_members` | `users.mjs`, `read-tool-registry.mjs` | `replies-users` |
| Emojis and stickers | `discord_list_expressions` | `messaging.mjs` (`listExpressions`) | `messaging` |
| Send, reply, bubbles | `discord_send_message`, `discord_reply`, `discord_send_messages` | `messaging.mjs` | `messaging`, `replies-users` |
| **Forward messages and attachments** | `discord_forward_messages` (1–10) | `messaging.mjs` (`forwardMessages`, `forwardResolvedMessage`), `shapes.mjs` (forwarded snapshots) | `forwarding` |
| Server administration (channels, categories, roles, member roles) | `discord_create_channel`, `discord_create_category`, `discord_create_role`, `discord_add_role`, `discord_remove_role` | `guild-admin.mjs`, `discord-api.mjs` (audit-log `reason` header) | `guild-admin` |
| Reactions | `discord_add_reaction` | `reactions.mjs` | `reactions` |
| Web and project reading | `web_read_link`, `project_*`, `discord_research_topic`, `read_tool_result` | `read-tools.mjs`, `link-reader.mjs`, `project-tools.mjs` | `proactive-read-tools`, `proactive-context-tools` |

## Nova (background, owner-only)

| Feature | How it's triggered | Modules | Tests |
| --- | --- | --- | --- |
| Channel listener | `discord_start_proactive` / `stop` / `status` | `tools.mjs`, `controller.mjs`, `supervisor.mjs`, `daemon.mjs` | `proactive-controller`, `proactive-supervisor` |
| Owner DMs | `discord_start_direct_messages` | same + `target.mjs` (`assertOwnerDirectMessageChannel`) | `direct-messages` |
| Owner mentions across all servers | `discord_start_server_mentions` | `server-mentions.mjs`, `reply-scheduler.mjs` | `server-mentions` |
| Trigger modes (`mentions` / `questions` / `all`) and batching | owner messages | `engine.mjs` (`receive`, `isQuestion`) | `proactive-engine` |
| Streamed reply bubbles | model output | `reply-stream.mjs`, `conversation.mjs`, `engine.mjs` | `reply-stream`, `codex-responder` |
| Native replies, chunking, generated text files | reply plan `messages`, `files` | `reply-sender.mjs`, `discord-chunks.mjs` | `reply-sender`, `discord-experience` |
| Discord timestamps (`<t:unix:format>`) in replies | prompt rule plus Unix fields (`currentUnix`, transcript `[HH:MM|unix]`, `...Unix`, batch `unix`) | `instructions/nova/`, `context.mjs`, `activity.mjs`, `search.mjs` | `activity` |
| Owner reply buttons, attached when the model chooses | reply plan `controls` | `reply-style.mjs`, `instructions/nova/03-reply-plan.md`, `reply-validation.mjs`, `reply-sender.mjs` (`controls`), `engine.mjs` | `reply-controls`, `reply-sender` |
| Reactions (natural and status ⏳⚙️🔎✅⚠️⌛) | reply plan `reactions`; engine stages | `reply-sender.mjs` (`react`, `statusReaction`) | `reactions` |
| **Forwards** | reply plan `forwards` (≤ 5), sent after bubbles and files | `reply-style.mjs`, `reply-validation.mjs`, `reply-sender.mjs` (`forwards`), `read-tools.mjs` (`forwardSource`) | `forwarding` |
| **Connected apps (Gmail, Drive, GitHub, Linear, …), read-only** | owner DM tool calls `apps_list_tools`, `apps_call_tool`; `nova.json` `apps` | `connected-apps.mjs`, `read-tools.mjs`, `channel-runtime.mjs` | `connected-apps` |
| Share app images (Slides thumbnails, Figma screenshots, image attachments) | reply plan `images` with handles from `apps_call_tool` results | `read-tools.mjs` (`shareableImages`, `sharedImage`), `reply-sender.mjs` (`images`), `discord-api.sendMessageImages` | `connected-apps` |
| **Web search** (Codex built-in), shown in the progress log | model decides; `nova.json` `webSearch` | `conversation.mjs` (thread config, `webSearch` items → progress), `channel-runtime.webSearchMode`, `progress.mjs` | `web-search` |
| Scoped read tools during a turn | model tool calls | `read-tools.mjs`, `read-tool-registry.mjs` | `proactive-read-tools` |
| Progress log: one line per tool call, edited from "I'm …" to "I've …", condensed into a one-sentence summary when the answer is done | tool events with `arguments` | `progress.mjs`, `conversation.callTool` | `proactive-progress` |
| **Post in other channels from the owner DM** | reply plan `channelMessages` (≤ 3) | `reply-validation.mjs`, `read-tools.sendTarget`, `reply-sender.mjs` (`channelMessages`, `confirmation`), `engine.mjs` | `channel-messages` |
| Images and voice notes in context | attachments | `context-media.mjs`, `voice-transcriber.mjs` | `proactive-context-tools`, `voice-transcriber` |
| Owner memory | `remember this …`, `show memory`, `consolidate memory`, Remember button | `memory.mjs`, `memory-commands.mjs` | `memory` |
| Controls | `nova <action>` text, `/nova` slash command, buttons (reply buttons only when the plan sets `controls`), `discord_nova_control` | `controls.mjs`, `engine.mjs` (`control`), `channel-runtime.mjs` (`control`), `daemon-controls.mjs` | `nova-controls`, `codex-runtime-controls` |
| Model, effort and Fast settings | `nova model/effort/fast` | `conversation.mjs` (`configure`), `nova-settings.mjs` | `codex-runtime-controls` |
| Steer, stop, cancel, pause, reset, compact | `nova steer/stop/pause/…` | `engine.mjs`, `conversation.mjs` | `nova-controls` |
| Durable deliveries and recovery | automatic; `nova deliveries`, `resolve-delivery` | `delivery-journal.mjs`, `reply-sender.mjs` (`deliver`), `channel-runtime.mjs` (`recover`) | `delivery-journal`, `channel-runtime-integration` |
| Research jobs (new public thread) | `nova research …`, `nova jobs …` | `research-jobs.mjs`, `server-mentions.mjs` (`bindThread`) | `research-jobs` |
| Opted-in digests | `nova digest add/list/run/remove` (owner DM listener) | `digests.mjs` | `proactive-digests` |
| Gateway resilience | automatic | `gateway.mjs`, `gateway-strategy.mjs`, `supervisor.mjs` | `gateway-recovery`, `proactive-supervisor` |
| PDF attachment reading and scanned-page vision | current request/reply context; `discord_read_pdf` | `pdf-reader`, `pdf-worker`, `context`, `read-tools` | `pdf-reader`, `proactive-pdf-tools` |
| Reminders and conditional alerts | explicit owner DM command or approved proposal | `schedules`, `schedule-conditions`, `schedule-lease`, `owner-capabilities` | `proactive-schedules`, `owner-capabilities-schedules` |
| Approved connected-app actions | `apps_prepare_action`, owner approval | `connected-apps`, `owner-actions`, `owner-capabilities` | `approved-app-actions`, `owner-actions` |
| Codex/Claude Code task handoffs | selected T3 project/model, owner approval/control | `t3-client`, `task-handoffs`, `owner-capabilities` | `t3-client`, `task-handoffs`, `owner-capabilities-handoffs` |

## Packaging

| Feature | Modules | Tests |
| --- | --- | --- |
| Claude/Codex plugin bundle | `scripts/build-plugin.mjs`, `plugins/discord/*` | `plugin` |
| Stdio transport and tool list | `index.mjs`, `server.mjs` | `stdio` |
