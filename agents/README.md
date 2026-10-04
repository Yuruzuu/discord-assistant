# Agent docs catalog

Focused reference docs for agents working in this repository. Start with the
root [AGENTS.md](../AGENTS.md) for orientation and the rules that must not break.

| Doc | Contents |
| --- | --- |
| [architecture.md](architecture.md) | Processes (MCP server, controller, supervisor, daemon, Codex app-server), layering, request and reply data flow, module-by-module map |
| [features.md](features.md) | Feature catalog: each user-visible capability → entry points, modules, tests |
| [tools.md](tools.md) | Every MCP tool and Nova worker tool: handler, module, side effects, schema source |
| [nova-pipeline.md](nova-pipeline.md) | Nova's turn lifecycle: trigger → batching → context → Codex turn → streamed bubbles → plan validation → delivery |
| [security-invariants.md](security-invariants.md) | Owner gating, read scopes, send safety, file and link safety, secrets. Check every change against it |
| [configuration-and-state.md](configuration-and-state.md) | Environment variables, credentials, plugin launcher, every on-disk state file and its owner |
| [testing.md](testing.md) | Test layout, fixtures and fakes, which suite covers what, gotchas |
| [playbooks.md](playbooks.md) | Step-by-step recipes: add an MCP tool, add a Nova reply-plan action, add a worker read tool, add a `nova` control, release |

## Keeping these docs current

- If you add, rename or remove a module, tool, plan field, env var or state
  file, update the matching doc in the same change.
- Prefer naming modules and functions over quoting line numbers, because line
  numbers rot.
- Keep each doc scannable: tables and short bullets, not prose.
