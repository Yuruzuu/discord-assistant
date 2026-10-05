# Reminders and conditional alerts

`src/proactive/schedules.mjs` exports `createScheduleManager`. The owner-DM
listener owns one manager per account, with an exclusive process lease and
private atomic state under `$XDG_DATA_HOME/discord-mcp/schedules/<account>.json`.
No schedules exist until an explicit owner request is accepted by the host.

The manager accepts `service`, `accountId`, `apps` (the read-only connected-app
bridge), `deliver(payload, signal)`, and optional `root`, `timeZone`, `now`,
`checkTimeoutMs`, `setTimeout` and `clearTimeout` dependencies. The default zone
is `Asia/Manila`; production callers should pass the owner's configured zone.
Its lifecycle is `await ready` followed by `await close()` on shutdown.

Every public operation requires `userId === directMessageOwnerId`:

- `addReminder({ userId, content, runAt, intervalMinutes?, timeZone? })`: one
  future reminder or a recurring reminder. `runAt` is Unix milliseconds or ISO
  text with an explicit UTC offset; relative dates must be resolved before this
  boundary. Repetition is 5 minutes to one week.
- `addAlert({ userId, content, condition, intervalMinutes?, repeat?, expiresAt?,
  timeZone? })`: checks every 15 minutes by default (minimum 5). Once-only by
  default; an expiry stops polling without sending.
- `list`, `status`, `update`, `remove`, `runNow`, `resolveOutcome`: inspect,
  change, pause, cancel, explicitly check, and resolve delivery uncertainty.
  `runNow` defaults to a forced owner-requested check; timers use `force: false`.
  Updating conditions is intentionally excluded: create a new alert instead.

`schedule-conditions.mjs` provides strict declarative conditions:

- `{ type: 'discord', guildId, query?, authorIds?, channelIds? }` searches only
  new messages after the creation cursor. Channel filters are verified against
  the server. A confirmed repeating alert advances its cursor; quiet checks do
  not call a model or send messages.
- `{ type: 'app', tool, arguments?, predicate: { path, operator, value? } }`
  accepts available read-only connected-app tools and bounded credential-free
  arguments. `path` selects structured output and `operator` is `equals`,
  `includes` or `exists`. Repeating alerts fire on false-to-true transitions,
  preventing repeated notifications while a condition remains true. Private
  app results are never copied into the notification; only owner-authored
  reminder text is delivered in the owner DM.

The delivery callback receives `{ id, kind, operationId, nonce, ownerUserId,
content, privateOwnerData? }` and must send only to the verified owner DM with
mentions disabled. Use the supplied deterministic nonce and host delivery
journal. A confirmed receipt is required before advancing schedule state.
Pending sends are persisted before delivery, and any failed or unknown send
halts the schedule across process restarts. The owner must resolve its outcome
before another send. If the callback uses the shared delivery journal, resolve
its matching operation as well as the schedule's `pendingDelivery`.

Timers are clamped to Node's maximum delay and re-armed for distant dates.
Recurring reminders skip missed intervals and send once after downtime, rather
than flooding the owner. Checks have a 60-second timeout (configurable up to
120 seconds). At most 50 schedules are retained; remove completed entries when
the list fills. The test suite is `test/proactive-schedules.test.mjs`.
