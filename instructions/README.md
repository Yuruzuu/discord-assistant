# Instructions

Plain-Markdown prompts loaded at runtime by `src/instructions.mjs`. Edit them
here instead of in code.

| Path | Used by | Loaded when |
| --- | --- | --- |
| `nova/*.md` | Nova's Codex conversations (`src/proactive/conversation.mjs`) | Each new Nova conversation: listener start, `nova reset`, or after an error resets the thread |
| `mcp-server.md` | MCP server instructions for Claude Code and Codex (`src/server.mjs`) | MCP server start |

## Rules

- **Combining:** every `.md` file in `nova/` is joined in file-name order. The
  numeric prefixes set that order, so to add a topic you can drop in a new file
  such as `05-something.md`. This README and files starting with `_` are
  ignored.
- **Comments:** `<!-- HTML comments -->` are stripped, so use them for notes to
  editors.
- **Placeholders:** `{{ownerUserId}}` is filled in by the host. An unknown
  placeholder is an error, so typos fail loudly instead of reaching the model.
- **What lives elsewhere:** the hard limits (reply-plan schema, validation,
  scopes, rate limits) are enforced in code. Changing these files changes
  behaviour and tone, not what Nova is technically allowed to do. See
  `agents/security-invariants.md`.
- **Plugin builds:** `npm run build:plugin` copies this folder into
  `plugins/discord/runtime/instructions/`. The plugin launcher points
  `DISCORD_INSTRUCTIONS_DIR` there. Set that variable yourself to use a
  different folder.
