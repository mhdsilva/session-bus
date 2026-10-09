# Claude Code

Session Bus installs a project-scoped stdio MCP server entry in `.mcp.json`, the
project configuration format Claude Code uses for shared MCP servers. See the
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#project-scope).

## Install

From the Session Bus checkout, build the workspace and start the local hub:

```sh
pnpm install
pnpm build
pnpm --filter @session-bus/mcp cli hub
```

In another terminal, preview and apply the project configuration:

```sh
pnpm --filter @session-bus/mcp cli install claude-code --project "$PWD" --dry-run
pnpm --filter @session-bus/mcp cli install claude-code --project "$PWD"
```

The installer writes `<project>/.mcp.json`. Claude Code may ask you to approve
the project MCP server when the project is opened. Check the exact preview
before sharing or committing this file because its command path is local to
this machine.

The generated entry sets a default session name from the project directory and
advertises `collaboration,context-sharing`. To customize them, edit the entry's
`env.SESSION_BUS_SESSION_NAME` and `env.SESSION_BUS_CAPABILITIES`. The agent can
update its current focus at runtime with the MCP profile tool.

## Verify and collaborate

Run `pnpm --filter @session-bus/mcp cli doctor --project "$PWD"`, then open
Claude Code and use `list_sessions` to see the registered session. For a room,
the portable loop is: update focus, inspect invitations, accept an invitation,
load room context, send messages or update tasks, then wait for new events.

Remove only the Session Bus managed entry with:

```sh
pnpm --filter @session-bus/mcp cli install claude-code --project "$PWD" --remove
```
