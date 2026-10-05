# Coding task handoffs through T3 Code

Nova delegates coding work to the local T3 Code server. T3 owns the Codex and Claude Code harnesses and their existing authentication. Nova does not copy harness credentials or run arbitrary shell commands itself.

## Owner controls

Task controls are available only to the configured owner in a DM. Inspect the T3 catalog first, then select its exact project ID and a supported model ID. `codex` maps to T3's `codex` driver; `claude-code` maps to `claudeAgent`. An unavailable or unauthenticated harness is rejected.

The handoff request contains `projectId`, `harness`, `model`, `title`, and `request`. Nova starts it only after an explicit owner command or approval of the exact prepared proposal. A task works in the selected T3 project's existing root workspace and uses `approval-required` mode. It may modify that project after the owner authorizes the task and its requested operations. No project is selected automatically.

Nova can show the status of its own tasks, send steering instructions, stop active work and queued messages, and respond once to a specific pending T3 approval. Approval controls bind the Nova task, T3 request, owner, and DM. Session-wide and permanent approval choices are excluded. Existing unrelated T3 tasks cannot be controlled through a guessed ID.

## Runtime and connection

`configureT3Connection()` uses the installed T3 desktop application's supported `auth session issue` CLI to create a dedicated Nova bearer session. It writes `~/.config/discord-mcp/t3-session.json` with mode `0600`. It returns connection metadata, never the credential. The default session expires after 30 days; reconnect to replace an expired session. T3 Code must remain running.

The client reads the actual local server origin from `~/.t3/userdata/server-runtime.json`. It allows loopback HTTP origins only. The bearer is used solely to obtain a short-lived websocket ticket from `/api/auth/websocket-ticket`; the websocket receives only that ticket. HTTP redirects are rejected.

The adapter uses T3 orchestration protocol 2:

- `server.getConfig` and `orchestration.subscribeShell` provide the live harness and project catalogs.
- `orchestration.launchThread` creates the owner-selected coding task.
- `orchestration.getThreadProjection` and `orchestration.subscribeThread` observe its real state.
- `orchestration.dispatchCommand` handles steering, interruption, and pending approval responses.

## Progress and durability

Nova publishes sanitized actual command and tool activity. It never publishes provider reasoning items or command output through the activity reporter. Commands are temporarily shown in fenced code blocks. Approval prompts stay available until the owner decides; final results are delivered separately.

Durable task state contains IDs, selected project and harness, model, title, timestamps, and status. It excludes prompts, command contents, replies, and approval payloads. T3 keeps the task's authoritative transcript. Restarting Nova resumes observation without launching the task again; closing Nova does not cancel work in T3.

A launch uses a persisted deterministic thread and command ID. A timeout records an unconfirmed outcome and queries that exact T3 thread rather than retrying the launch. The owner should inspect T3 before submitting another task after an unknown result.

## Verification boundary

The adapter has offline transport and owner-control tests. Its authenticated live project and harness catalogs were verified against the installed T3 app without launching project-editing work. Actual edits, harness tool approvals, and Discord delivery should be checked with a deliberately selected owner task.
