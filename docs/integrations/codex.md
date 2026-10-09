# Codex

Session Bus installs a project-scoped MCP server entry in `.codex/config.toml`.
Codex loads project configuration only for trusted projects. See the
[Codex config reference](https://developers.openai.com/codex/config-reference/)
and [MCP setup](https://developers.openai.com/learn/docs-mcp).

## Install

Build the project and start the local hub:

```sh
pnpm install
pnpm build
pnpm --filter @session-bus/mcp cli hub
```

Preview and apply the integration from the target project:

```sh
pnpm --filter @session-bus/mcp cli install codex --project "$PWD" --dry-run
pnpm --filter @session-bus/mcp cli install codex --project "$PWD"
```

The generated table is `<project>/.codex/config.toml`. Review and trust the
project in Codex for this configuration layer to load. The entry includes
`SESSION_BUS_SESSION_NAME`, `SESSION_BUS_CAPABILITIES`, and other MCP environment
values. Edit the name and capabilities in that table to suit the session; the
agent can update its current focus at runtime through MCP.

## Verify and collaborate

Run `pnpm --filter @session-bus/mcp cli doctor --project "$PWD"`, open Codex in
the trusted project, and call `list_sessions`. Agents follow the same portable
loop across harnesses: update focus, inspect invitations, join, load room
context, communicate and update shared tasks, then wait for events.

Remove the managed server table while preserving the rest of the TOML file:

```sh
pnpm --filter @session-bus/mcp cli install codex --project "$PWD" --remove
```
