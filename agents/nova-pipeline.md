# Nova reply pipeline

How one owner message becomes Nova's reply. All modules are in `src/proactive/`.

## 1. Ingress

1. `gateway.mjs` receives `MessageCreate` (discord.js). It filters with
   `acceptsListenerMessage` (the owner only, plus the right channel, guild or DM)
   and normalises the message to a REST-like shape (`message_reference`,
   `message_snapshots`, `attachments`, …).
2. `channel-runtime.receive`:
   - A `nova <action>` text command (`controls.parseNovaCommand`) is executed
     immediately as a control.
   - Otherwise `journal.claimIngress` claims the message, so restarts don't
     answer it twice. Then it goes to `engine.receive`.
   - Messages with `hostProvenance` are host-injected tasks: owner controls,
     scheduled requests (digests), research jobs. They skip command parsing.
3. On startup, `channel-runtime.recover` replays ingress entries that never
   completed.

## 2. Trigger policy and batching (`engine.mjs`)

- Bot, webhook and duplicate messages are ignored (`seen` keeps the last 1000).
  Messages from anyone except the owner never get here.
- Explicit `nova stop|pause|resume|status|details|reset|compact|steer|model|effort|fast`
  messages go to `control()`.
- **Mode.** `mentions` responds to a mention or a native reply to the bot.
  `questions` also responds to anything `isQuestion` matches. `all` responds to
  everything (DMs always use `all`).
- **Batching.** Messages from the same author are merged for `batchWindowMs`
  (1.5 s). The batch is flushed at 5 messages or after 5 s. The queue is capped
  at 20 batches.
- **Pacing.** `cooldownMs` and `maxRepliesPerMinute` apply per engine. The
  all-servers listener also serialises across channels with
  `reply-scheduler.mjs`.
- **Status reactions** on the trigger: ⏳ queued → ⚙️ working → 🔎 tool → ✅
  done / ⚠️ error / ⌛ stalled (20 s). They are cleared 5 s after the turn.

## 3. Context (`context.mjs`, `context-media.mjs`)

- The last 15 channel messages (DMs: owner and bot only), the parents of reply
  triggers, and the server emojis and stickers the bot can use (cached for 60 s).
- Allowed GIF URLs, up to 3 images (≤ 2 MiB), voice-note transcripts (if a voice
  backend is configured), and forwarded snapshots (`forwardedMessages`,
  `forwardedMedia`). All of these are marked `untrustedContent`.
- `approvedMemory` is the current memory file snapshot (`memory.mjs`).
- `currentTime`, `currentUnix` and `ownerTimeZone` (from `nova.json` `timeZone`,
  otherwise the host zone) let Nova resolve "today" and write `<t:unix:format>`
  timestamps.

## 4. Codex turn (`conversation.mjs`)

- There is one Codex thread per conversation (the identity is the channel,
  guild and DM flag) on a pooled `codex app-server` (`codex-pool.mjs`). It runs
  in an ephemeral temp directory with a filtered environment
  (`worker-environment.mjs`), no approvals, and no native file or command access.
- Each turn sends only *new* nearby messages since the last turn
  (`newestContextId`), plus up to 8 image inputs mapped by `imageSources`.
- `outputSchema: replySchema` (`reply-style.mjs`) forces the JSON reply plan.
- The model calls read tools as dynamic tools. These are routed to
  `readTools.call(name, args)` and limited by `maxToolCalls` (24),
  `toolTimeoutMs` (30 s), and repeated-failure limits. The whole turn has
  `timeoutMs` (120 s, owner-adjustable with `nova budget`).
- In owner DMs, the model can also call `apps_list_tools` / `apps_call_tool`.
  The host forwards these to a separate hidden Codex thread with apps enabled
  (`connected-apps.mjs`), using read-only tools only. Reading app data blocks
  `web_read_link` until the next turn.
- Owner controls on the live thread: `steer`, `stop`, `reset`, `compact`, and
  `configure` (model, effort, Fast).

## 5. Streaming bubbles (`reply-stream.mjs`)

The agent-message deltas are parsed incrementally. When `shouldReply` is `true`
and each `messages[i]` object closes, it is validated (`validator.message`) and
delivered right away through `engine` → `sendReplies([message], …, { offset })`.
Unknown top-level keys abort the turn. This is why **new plan keys must be added
to the allow-list in `reply-stream.mjs`**.

## 6. Plan validation (`reply-validation.mjs`)

The final JSON is parsed with a strict zod `planSchema`:

| Field | Limit | Checks |
| --- | --- | --- |
| `shouldReply` | bool | `false` drops messages, files and forwards (reactions are kept) |
| `messages[]` | ≤ 5 | content ≤ 16000 (chunked later); `gifUrl` must be in `allowedGifUrls`; stickers must be available; custom emoji markup must exist in the catalog |
| `reactions[]` | ≤ 3 | target must be one of the supplied conversation messages; emoji normalised; deduped |
| `files[]` | ≤ 3 | safe basename, text, ≤ 128 KiB each, ≤ 256 KiB total (`discord-chunks.validateGeneratedFiles`) |
| `forwards[]` | ≤ 5 | snowflake `channelId` and `messageId`; deduped by message. Scope is checked later at send time |
| `images[]` | ≤ 4 | handles (`img<n>`) of images returned by connected-app tools in this answer, deduped. Unknown handles fail at send time |
| `channelMessages[]` | ≤ 3 | `{channelId, content ≤ 2000, notify}`. **Owner DM only** (otherwise the turn fails). The target is checked at send time by `readTools.sendTarget` |
| `controls` | bool | `true` asks the host to attach the owner buttons to this reply. The model decides per answer, and it is dropped when `shouldReply` is false |

A reply with `shouldReply: true` needs at least one message, file or forward.
If a published bubble differs from the final plan, the turn errors
("changed a reply bubble after publishing it").

## 7. Delivery (`engine.processBatch` → `reply-sender.mjs`)

Order: **reactions → remaining (unstreamed) bubbles → files → images → channel posts + host confirmation → forwards → owner buttons (only if `controls`).**

- **Native reply.** Only in servers, and only on the first bubble or chunk, when
  the batch has more than one message, the trigger is itself a reply, or newer
  messages from other people arrived. DMs never use native replies.
- **Nonces.** `batchId = sha256("<listenerId>:<triggerId>")[0:20]`.

  | Operation | Nonce | Journal operation ID |
  | --- | --- | --- |
  | bubble *n* | `<batchId>:<n>` | `<batchId>:<n>:text:0` |
  | chunk *k* of bubble *n* | `<batchId>:<n>c<k>` | `<batchId>:<n>:text:<k>` |
  | progress *i* | `<batchId>:p<i>` | (not journaled) |
  | files | `<batchId>:f` | `<batchId>:files` |
  | images | `<batchId>:i` | `<batchId>:images` |
  | channel post *i* | `<batchId>:x<i>` | `<batchId>:channel:<i>` |
  | post confirmation | `<batchId>:k` | `<batchId>:confirmation` |
  | forward *i* | `<batchId>:w<i>` | `<batchId>:forward:<i>` |

  Discord nonces are at most 25 characters, so keep suffixes short.
- **`deliver()`.** It looks up the journal first. If a receipt already exists,
  it is reused. An `unknown` status refuses to resend: the owner inspects it
  with `nova deliveries` and resolves it with `nova resolve-delivery`. The
  journal records `rejected` and `unknown` outcomes from `error.sendStatus`.
- **Channel posts.** Each `channelMessages` item goes through `sendTarget`, then
  `sendResolvedMessage` into the target channel. With `notify`, only `<@id>`
  users found in the content are pinged (`allowed_mentions.users`, max 5).
  Journal entries use the DM channel ID as metadata. The engine then sends a
  host-written confirmation ("Posted in <#…>: link" or "I couldn't post…") to
  the DM, and a failure still fails the turn.
- **Forwards.** Each source goes through `forwardSource`
  (`readTools.forwardSource`, which uses the same scope rules as reading). The
  sender then calls `messaging.forwardResolvedMessage`. Forwards land only in
  the current conversation.
- **Owner buttons.** Remember, Read more, Retry and Details are opt-in for each
  reply. The sender records the first confirmed bubble or file message
  (`rememberFirstReply`). `send.controls(trigger)` attaches the buttons by
  editing that message, and only when the final plan has `controls: true`.
  Progress messages always get Details and Stop answer while Nova works
  (`controls.createControlButtons`).
- `mentions` is always off (`allowed_mentions.parse: []`). Nova is prompted to
  write `<#channelId>` and `<@userId>` (IDs taken from context or tool results);
  these render as clickable names without notifying anyone. The persona and
  formatting style (conversational, light markdown) live in `reply-style.mjs`.

## Progress log (`progress.mjs`)

In editable mode, one progress message is a running log with one line per tool
call, matched by `callId`. Each line is edited from "I'm …" to "I've …" when its
call finishes. Edits are throttled to `intervalMs` but deferred rather than
dropped. When the answer finishes, the log becomes a single summary sentence
that groups verbs ("I checked your connected apps and your Gmail, and searched
…") and its buttons are removed. A stopped or failed answer keeps its steps and
adds a closing note. Arguments are sanitized as described in
[security-invariants.md](security-invariants.md).

## 8. After the turn

`onBatchComplete` marks ingress `sent`, `failed` or `cancelled`. It also
resolves host `request()` promises (digests) from the journal receipts. Engine
statistics (`sentMessages`, `streamedMessages`, `reactions`, `forwards`,
`errors`, timing) appear in listener status.
