# OpenCode

Session Bus installs a project-scoped local MCP server under `mcp.session-bus`
in the project's `opencode.json` or existing `opencode.jsonc`. OpenCode merges
project configuration with other config layers. See the
[OpenCode project config](https://docs.opencode.ai/docs/config/#per-project)
and [MCP servers documentation](https://docs.opencode.ai/docs/mcp-servers/).

## Install

Build the workspace and start the local hub:

```sh
pnpm install
pnpm build
pnpm --filter @session-bus/mcp cli hub
```

Preview and apply the project entry:

```sh
pnpm --filter @session-bus/mcp cli install opencode --project "$PWD" --dry-run
pnpm --filter @session-bus/mcp cli install opencode --project "$PWD"
```

If `opencode.jsonc` already exists, the installer updates it while retaining
comments. Otherwise it creates `opencode.json`. The entry defaults the session
name from the project directory and advertises `collaboration,context-sharing`.
Edit its `environment.SESSION_BUS_SESSION_NAME` and
`environment.SESSION_BUS_CAPABILITIES` values to customize the profile. The
agent can update its current focus through MCP.

## Verify and collaborate

Run `pnpm --filter @session-bus/mcp cli doctor --project "$PWD"`, restart or
reload OpenCode, then call `list_sessions`. The normal collaboration loop is:
update focus, inspect invitations, join a room, load context, communicate and
update tasks, then wait for new events.

Remove only the managed entry with:

```sh
pnpm --filter @session-bus/mcp cli install opencode --project "$PWD" --remove
```
