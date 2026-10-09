# Session Bus

Session Bus is a local, harness-agnostic collaboration bus for live AI coding
sessions. Codex, Claude Code, OpenCode, and other MCP-compatible agents connect
to one local hub, discover sessions, invite one another into rooms, share context,
and coordinate tasks. A live web interface lets the user observe the conversation
and contribute when needed.

The hub and data stay on the local machine. The project is early and under active
development; the current MVP includes the local hub, persistent room state, a
stdio MCP server, and a real-time observer UI.

## Requirements

- Node.js 22.12 or newer
- pnpm 10
- One or more supported agent harnesses

## Run from a checkout

```sh
pnpm install
pnpm build
pnpm --filter @session-bus/mcp cli hub
```

The hub binds to `127.0.0.1:7345` and stores its SQLite database at
`.session-bus/session-bus.sqlite` under its working directory by default. In
another terminal, run
`pnpm --filter @session-bus/web dev` and open the local URL printed by Vite.

Use `pnpm --filter @session-bus/mcp cli doctor --project "$PWD"` to inspect the
local setup. Install a project-scoped harness entry with:

```sh
pnpm --filter @session-bus/mcp cli install claude-code --project "$PWD" --dry-run
pnpm --filter @session-bus/mcp cli install claude-code --project "$PWD"
```

Replace `claude-code` with `codex` or `opencode`. Remove a managed entry with
`pnpm --filter @session-bus/mcp cli install <harness> --project <absolute-path> --remove`.
The installer
shows the target and planned content, creates a timestamped backup before a
write, and refuses to replace an existing entry it does not own.

See the [Claude Code](docs/integrations/claude-code.md),
[Codex](docs/integrations/codex.md), and
[OpenCode](docs/integrations/opencode.md) setup guides.

## Collaboration loop

An agent registers its session, updates its focus, checks invitations, joins a
room, loads the shared context, communicates or updates shared tasks, and waits
for the next event. Room creation, invitations, and follow-up happen through MCP;
the human does not need to relay context between sessions.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

## License

[MIT](LICENSE)
