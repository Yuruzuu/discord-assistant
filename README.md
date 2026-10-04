# Discord MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for
Discord. It discovers every server visible to one or more configured bots, reads
channels and ticket threads, resolves Discord message URLs, and returns safe image
attachments as MCP image content. It also lists server emojis and stickers and
can send messages as a configured bot when explicitly requested.
An on-demand proactive server can also listen to a selected channel and answer
mentions or questions using the logged-in Codex CLI.

Reading and discovery use Discord REST `GET` requests. Sending tools post
messages, and DM startup opens or reuses the owner's private conversation.
It does not edit, delete, react to, or
moderate anything. Proactive mode keeps private process-control files and uses
the Gateway while active; it does not auto-start or require a polling schedule.

## Requirements

- Node.js 18 or newer.
- A Discord application with a bot. One bot can be invited to multiple servers.
- Enable **Message Content Intent** under Developer Portal > Bot > Privileged
  Gateway Intents. Discord applies this intent to message content, embeds, and
  attachments returned to verified apps, including REST message reads.
- Grant the bot **View Channel** and **Read Message History** only where it should
  read. Add it to private threads that it needs to inspect.
- For sending, grant **Send Messages** in the target channel, or **Send Messages
  in Threads** for a thread. Reading tools do not need these permissions.

For a LonglenAI setup, invite the same reader bot to `longlenai`,
`longlenai-creator`, and `longlenai-dev`. Discord server and channel permissions
remain the access boundary.

## Codex plugin

The Codex plugin bundles the same server and a `use-discord` skill. It requires
Node.js 22 or newer. Build and install it from this checkout:

```bash
npm ci
npm run build:plugin
codex plugin marketplace add .
codex plugin add discord@yuruzuu-discord
```

Restart Codex after installation, then enable **Discord** in Plugins and use
its tools or the bundled skill. The build outputs a self-contained plugin under
`plugins/discord`, with its runtime dependencies bundled. The checkout's
`node_modules` directory and credentials are not part of that plugin.

Store credentials outside the plugin at `~/.config/discord-mcp/.env`, or set
`DISCORD_ENV_FILE` to a credentials file. `XDG_CONFIG_HOME` is respected when set.
The file supports the same `DISCORD_TOKEN` and multi-account environment variables
as the standalone server. Keep it private, for example with `chmod 600`.
Directly supplied environment variables take precedence over file values.

Avoid enabling both this plugin's server and a standalone Codex `discord` MCP
registration at once. Disable the standalone entry after verifying the plugin:

```toml
[mcp_servers.discord]
enabled = false
```

The standalone entry points remain available for Claude Code and other MCP
clients. After server changes, run `npm run build:plugin` and refresh the plugin
installation so its bundled runtime picks up the new code. The build derives the
Codex compatibility manifests from the portable manifests; edit `plugin.json`
and `mcp.json` in `plugins/discord` rather than those generated compatibility
files.

This is a local Codex plugin. Public directory distribution requires a separate
submission and a supported deployed MCP connection. Packaging a plugin does not
grant Discord permissions or change a chat's network policy.

## Install and run

```bash
npm install
DISCORD_TOKEN=your_bot_token npm start
```

`DISCORD_TOKEN` is the v1-compatible single-bot configuration. For named or
multiple bots, keep token values in environment variables and point account
definitions at those variable names:

```bash
export DISCORD_TOKEN_LONGLENAI_READER='your_bot_token'
export DISCORD_ACCOUNTS_JSON='[{"id":"longlenai-reader","tokenEnv":"DISCORD_TOKEN_LONGLENAI_READER","priority":100}]'
node index.mjs
```

`DISCORD_ACCOUNTS_FILE` can contain the same JSON array. Never put a token value in
that file; `tokenEnv` is an environment variable name, not a token.

## Tools

| Tool | Purpose |
| --- | --- |
| `discord_list_servers` | List all servers visible across configured bot accounts and report account health. |
| `discord_list_channels` | List categories, channels, active threads, and optionally archived threads for one server. |
| `discord_list_tickets` | Find forum posts, threads, and optionally text-channel tickets with parent/category/name/time filters. |
| `discord_read` | Read a message/channel URL or IDs, auto-select the bot with access, and inline image attachments. |
| `discord_search_messages` | Search indexed server messages and return up to 250 matches with links and continuation arguments. |
| `discord_message_context` | Jump to a message and read its surrounding conversation. |
| `discord_browse_messages` | Browse up to 250 messages at a time with older/newer cursors. |
| `discord_start_direct_messages` | Start private DM conversations for the fixed owner only. |
| `discord_stop_direct_messages` | Stop DM replies independently of server listeners. |
| `discord_direct_message_status` | Inspect the DM listener, owner ID and reply statistics. |
| `discord_start_server_mentions` | Opt in to owner mentions/replies across all accessible server channels. |
| `discord_stop_server_mentions` | Stop server-wide watching independently of DMs. |
| `discord_server_mentions_status` | Inspect server coverage and per-conversation statistics. |
| `discord_fetch_attachment` | Fetch one selected image from a message or a direct Discord CDN/media URL. |
| `discord_check_access` | Diagnose which configured bot can read a guild, channel, or message. |
| `discord_list_expressions` | List custom emojis and stickers, with ready-to-use emoji markup, sticker IDs, availability, and role restrictions. |
| `discord_send_message` | Send bot messages with text, custom emojis, and up to three server stickers. |
| `discord_reply` | Use Discord's native reply feature for a specific message, with optional reply notifications. |
| `discord_send_messages` | Send one to five short message bubbles in order, reporting partial receipts if a send fails. |
| `discord_user_info` | Get a public profile, avatar and creation date, plus server nickname, join date and roles when requested. |
| `discord_start_proactive` | Start a background channel listener powered by the logged-in Codex CLI. |
| `discord_stop_proactive` | Stop that listener and cancel pending replies. |
| `discord_proactive_status` | Read listener state, mode, queue, reply counters and errors. |

The four v1 tools remain as compatibility aliases:
`discord_get_message`, `discord_read_messages`, `discord_get_channel`, and
`discord_get_server_info`.

## Search and browse context

`discord_search_messages` uses Discord's guild search endpoint. Supply a
`guildId` and optional `query`; the default result limit is 250, newest first.
It supports channel/author/mention filters, reply targets, attachment and embed
types, pinned state, snowflake bounds, and timestamp/relevance sorting.
Only messages visible to the selected bot are returned.

Discord's search pages contain at most 25 results, so the tool gathers pages
until it reaches the requested limit. It retries index-building responses and
does not treat short search pages as completion. Results include `totalResults`,
`nextOffset`, `continuation`, indexing state and `offsetLimitReached`. Discord's
offset window ends at 9975; the tool reports that boundary instead of silently
claiming a complete search.

Pass a result's message URL to `discord_message_context` to jump into its
conversation. Context is returned oldest first, with the anchor message and
older/newer navigation arguments. Use those arguments with
`discord_browse_messages` to continue browsing, up to 250 messages per call.
Images are opt-in with `includeImages`; search results provide attachment
references without downloading them. A deleted anchor remains an error.

## Sending messages and expressions

Call `discord_list_expressions` with a `guildId` to discover that server's
expressions. Its `kind` can be `all`, `emojis`, or `stickers`. Custom emoji entries
include `markup` such as `<:wave:123456789012345678>` or animated
`<a:wave:123456789012345678>`. Include that exact markup in
`discord_send_message.content`. Include sticker IDs in `stickerIds`:

```json
{
  "guildId": "100000000000000001",
  "channelId": "200000000000000001",
  "content": "Hello <:wave:123456789012345678>",
  "stickerIds": ["300000000000000001"]
}
```

Messages come from the selected bot account. Content is limited to 2000
characters; a sticker-only message may omit content. Mention notifications are
disabled by default; explicitly set `allowMentions: true` when wanted. Discord
still enforces channel permissions, emoji role restrictions, and sticker
availability.

Sending is marked as a write tool and should only be called when the user asks
to send. It shares the bounded request queue and rate-limit handling, but sends
are never combined with other sends. Each send uses Discord's `enforce_nonce`
deduplication. Supply the same `nonce` when retrying a send; deduplication applies
within Discord's recent-message window. Failed rate-limited sends can retry;
ambiguous network or server failures are returned without automatically resending.

Use `discord_reply` with `channelId`, `messageId` and message content to reply
natively. `mentionRepliedUser` controls the reply ping separately from other
mentions, and defaults to false. `discord_send_message.replyToMessageId` also
supports native replies. A deleted target causes the reply to fail instead of
silently becoming an unrelated message.

Use `gifUrl` to send an existing HTTPS GIF or GIF page URL, with or without text.
Discord handles its preview. Content and the appended URL together must fit in
2000 characters. `discord_send_messages` accepts a `messages` array of message
objects and spaces them by `intervalMs` (650 ms by default). Its optional
`replyToMessageId` applies to the first bubble. A stable `batchId` gives each
message a stable nonce; partial failures include `sentMessages` and
`failedMessageIndex` so a retry can avoid duplicate sends.
The channel and bot route are resolved once per batch; each send still goes
through Discord's permission checks, rate limits and nonce deduplication.

## Proactive channel conversations

Start the listener only when you want the bot to participate in a channel:

```json
{
  "guildId": "100000000000000001",
  "channelId": "200000000000000001",
  "mode": "mentions"
}
```

Call `discord_start_proactive` with those arguments. It checks Codex CLI
availability and login, starts a detached local server, and reports running state
after the Gateway is ready. No startup greeting is posted. `mentions` responds
to owner bot mentions and native replies to the bot. `questions` also considers
owner questions; `all` considers every owner message. Messages from bots and
webhooks are ignored, and repeated Gateway messages are deduplicated.
Automatic responses in every mode are restricted to owner
`291140236979732480`. Other users are rejected at both the Gateway and engine
before lookups, typing, context loading or model generation.

The bot appears online while its Gateway listener is active. Enable **Message
Content Intent**, **View Channel**, **Read Message History**, and the relevant
**Send Messages** / **Send Messages in Threads** permission. Only the selected
channel is processed. The server continues running when its calling MCP process
closes, until you call `discord_stop_proactive` or stop the computer/process.
It does not auto-start on login or when Codex opens.

Nearby message bubbles from one author are grouped before generating a reply.
Responses are generated one at a time, defaulting to a five-second cooldown and
at most six model attempts per minute. Nova defaults to `gpt-6.1-sol`,
`reasoningEffort: "low"` (Light) and `serviceTier: "priority"` (Fast).
The defaults are independent of the global Codex model settings. Startup can
override `model`, `reasoningEffort` or `serviceTier`; `"default"` selects Standard
service. See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
The worker uses your Codex quota and existing saved CLI login. Each conversation
keeps one warm Codex app-server process and one ephemeral, in-memory thread.
Later messages continue that thread, with nearby context sent incrementally.
This preserves conversation state and allows prompt-cache reuse; actual cache
hits depend on the service and are reported in `conversation.cachedInputTokens`.
DM and server threads are separate. Stopping/restarting a listener discards its
ephemeral conversation; approved memory survives independently.

Shell, plugin, hook, web-search and external MCP tools are disabled in the worker.
The host supplies seven read-only Discord tools for server/channel discovery,
member-name lookup, message search, surrounding context, history browsing and
user profiles. Owner DMs can research any server the bot can access; server
conversations can read only their own server. No worker can read other private
conversations or send outside its reply conversation. Searches support up to
250 matches and continuation pages; context reads preserve message links.
The host handles Discord credentials and validates every tool call. The worker
receives no Discord token and uses a temporary, read-only permission profile.
That profile is only an in-memory worker override; it does not edit Codex's
global configuration. The implementation is validated with Codex CLI 0.160.0.

Important reading actions produce short activity messages, such as “i’m
searching the Discord chats now” or “i’m reading the surrounding messages for
context.” These reflect actual tool calls, with at most three updates per reply,
throttling and duplicate suppression. They stop once the answer starts. Progress
messages have separate nonces and do not use up final reply bubbles or alter the
first answer's native reply. Ordinary chat sends no progress filler. Raw internal
reasoning, tool arguments and message contents are never used as activity text.
Status reports `progressMessages`, `progressErrors` and `lastFirstActivityMs`.

Complete reply bubbles are validated and sent as the model streams them. The
first bubble gives a short useful answer; later bubbles add details. Raw partial
tokens and reasoning are never posted. Each bubble has a stable nonce, the first
keeps the native reply reference, and confirmed bubbles are not sent again at
turn completion. A failure after an early bubble stops the rest of the reply.
`statistics.lastFirstResponseMs` measures the most recent first-send delay from
local message receipt, and `statistics.streamedMessages` counts streamed sends.

Replies use the native reply feature and can be a few playful short bubbles.
The bot shows a typing indicator while gathering context, generating a reply
and sending its message batch, in server channels and owner DMs. It refreshes
the indicator every seven seconds while working and stops on completion,
failure or cancellation. Typing failures do not prevent a reply. Discord lets
the last typing indication expire after ten seconds; idle listeners do not
keep an indicator running. See [Discord's typing documentation](https://docs.discord.com/developers/resources/channel#trigger-typing-indicator).
Available server emojis, stickers, optional `gifUrls`, recent channel GIF links,
and animated emoji GIFs can provide expressions. Replies never ping users or
roles automatically. An uncertain send is not blindly retried.

Use `discord_proactive_status` with `channelId` to inspect a listener, and
`discord_stop_proactive` with `channelId` to stop it. Stop before changing an
active listener's configuration. `accountId` selects a specific configured bot.
`DISCORD_CODEX_COMMAND` can point to a Codex executable when it is absent from
`PATH`. Private control/status files and logs live under
`~/.local/share/discord-mcp/proactive` (or `XDG_DATA_HOME`).
Bursty statistics updates share a status-file write within a 250 ms window.
Lifecycle changes flush immediately, and live status requests use the current
in-memory state.

## Owner mentions across all servers

Call `discord_start_server_mentions` to explicitly enable watching all servers
the bot belongs to. No server or channel ID is needed. One Gateway connection
receives events from accessible channels and threads, including new channels
and servers joined while running. Discord channel permissions and private-thread
membership still determine visibility.

Only owner `291140236979732480` can trigger a response, by mentioning Nova or
replying natively to one of its messages. Ordinary chatter and other users'
pings do not create workers or use Codex quota. Conversation runtimes are created
lazily, with separate ephemeral threads and `memory.md` files per channel.

Server conversations share a single reply scheduler, the configured cooldown,
and the model-attempt limit (six per minute by default). Up to eight idle
conversation runtimes are retained; older idle runtimes close as needed, while
active/queued work is kept. Approved memory survives eviction.

Stop channel-specific listeners before enabling server-wide watching to prevent
duplicate replies. The controller rejects overlapping scopes, including
concurrent starts. `discord_server_mentions_status` reports `watchedGuildCount`
and per-channel statistics. `discord_stop_server_mentions` stops this mode;
owner DMs continue independently. This mode does not auto-start after a restart.

## Private owner DMs

Call `discord_start_direct_messages` to enable private conversations with the
bot. This installation is fixed to owner ID `291140236979732480`; no tool or
environment option can change that recipient. The listener opens or reuses the
bot's one-to-one DM with that owner, and checks the sender and channel before
context lookup or reply generation. Other senders, group DMs and server messages
are ignored by this listener.

Open the bot's profile in Discord and select **Message**. Owner messages trigger
replies without a mention or question mark. Replies use the logged-in Codex CLI,
native message replies, batching and the same cooldown/attempt limits as server
conversations. DMs use standard emojis and supplied or recent GIFs, without
fetching server expression catalogs. The DM Gateway uses the `DIRECT_MESSAGES`
intent and supports uncached DM channels; Message Content Intent is not needed
for messages sent directly to the bot. See [Discord's Gateway documentation](https://docs.discord.com/developers/events/gateway).

`discord_direct_message_status` reports the fixed owner, running state and reply
statistics. `discord_stop_direct_messages` stops DM replies independently of
server listeners. DM mode stays active while its background process and computer
are running, and does not auto-start after a restart. It only sees the owner's
conversation with the bot, not personal conversations with other Discord users.

## Owner-controlled memory

Each conversation has its own private `memory.md` under
`~/.local/share/discord-mcp/memory/<account-and-conversation>/` (or
`XDG_DATA_HOME`). DM memories are not injected into server threads. You can edit
the file directly; Nova reads the current contents before replying. New files
start empty, and ordinary chat is never automatically saved.
Unchanged notes reuse their snapshot and hash. File metadata checks still
detect manual edits and atomic replacements; changed contents reload before the
next reply. Consolidation skips replacement when the result is unchanged.

Only owner `291140236979732480` can issue these text commands:

- `remember this: I prefer short replies` saves exactly the approved note.
- Reply natively to a message with `remember this` to approve its text.
- `show memory` shows the saved notes, with a bounded preview for long files.
- `consolidate memory` formats and deduplicates approved text without inventing
  facts or inferring memories from chat. Consolidation runs only when requested.

In a mentions-only server channel, mention Nova or reply to Nova while issuing
the command. In the owner DM, no mention is required. Notes are limited to 2000
characters each and the file to 16 KiB. Saves use private permissions, serialized
writes and atomic replacement, with a check for concurrent manual edits. Status
includes `memoryFile` so the owner can locate the live file.

## Periodic callers

Scheduling is intentionally outside this MCP. A periodic job should persist its
own cursor and pass it back explicitly:

- Use `discord_list_tickets.updatedAfter` to find recently active tickets.
- Use `discord_read.after` with the newest message snowflake saved by the caller.
- Save `cursors.newest` only after the caller has processed the returned messages.

The MCP process keeps only disposable routing caches. Restarting it does not lose
caller state or change the periodic contract.

## Request handling

Each bot makes at most four concurrent network requests. Archived-thread scans
run with bounded concurrency and preserve channel and warning order. Ticket
category filters also limit which parents are scanned for archived threads.

Overlapping identical requests share one fetch; later channel and message reads
still fetch fresh data. Server discovery retains its process cache and supports
`discord_list_servers.refresh` to discover newly invited servers. Discord bucket
headers and global cooldowns delay requests when rate limits are exhausted, and
retries honor the full `Retry-After` interval.

Transient connection failures on reads retry with bounded backoff. Failed or
partial server discovery is not cached, so a subsequent call can recover without
requiring `refresh: true` or a client restart. If every bot fails discovery, the
tool reports an error with account diagnostics instead of a successful empty
server list. DNS, timeout, network-policy, and TLS failures include their cause
codes. Network-policy and certificate failures are not retried, and failed sends
are never automatically retried after a connection error.

Duplicate image downloads are reused within a read or while a matching fetch is
in progress. Image output counts and byte limits still apply to every returned
image. Rejected download streams are cancelled rather than left open. MCP text
results use compact JSON alongside the same structured results.

## Codex configuration

Codex can forward a named environment variable without storing its value in TOML:

```toml
[mcp_servers.discord]
command = "node"
args = ["/absolute/path/to/discord-readonly-mcp/index.mjs"]
env_vars = ["DISCORD_TOKEN_LONGLENAI_READER"]

[mcp_servers.discord.env]
DISCORD_ACCOUNTS_JSON = '[{"id":"longlenai-reader","tokenEnv":"DISCORD_TOKEN_LONGLENAI_READER","priority":100}]'
```

Launch Codex from a shell where `DISCORD_TOKEN_LONGLENAI_READER` is exported.

## Claude Code configuration

Project `.mcp.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-readonly-mcp/index.mjs"],
      "env": {
        "DISCORD_TOKEN_LONGLENAI_READER": "${DISCORD_TOKEN_LONGLENAI_READER}",
        "DISCORD_ACCOUNTS_JSON": "[{\"id\":\"longlenai-reader\",\"tokenEnv\":\"DISCORD_TOKEN_LONGLENAI_READER\",\"priority\":100}]"
      }
    }
  }
}
```

Restart the client after changing MCP configuration. Both Codex and Claude use the
same stdio server and tool schemas.

## Image controls

Images are fetched only over HTTPS from Discord CDN/media hosts. Redirect targets,
declared MIME types, file signatures, and byte limits are checked before returning
base64 MCP image blocks.

| Environment variable | Default | Maximum |
| --- | ---: | ---: |
| `DISCORD_MAX_IMAGE_BYTES` | 8 MiB per image | 25 MiB |
| `DISCORD_MAX_IMAGES` | 4 per call | 10 |
| `DISCORD_MAX_TOTAL_IMAGE_BYTES` | 20 MiB per call | 50 MiB |

## Development

```bash
npm test
npm pack --dry-run
```

Tests use mocked Discord REST responses and never need a real bot token.

## License

MIT (c) Vorakorn Kosidphokin
