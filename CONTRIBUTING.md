# Contributing

Session Bus is a local-first, single-user collaboration system. Keep transport,
domain rules, persistence, harness integration, and the observer UI separated:

- `packages/protocol` owns shared schemas and event types.
- `packages/domain` owns session, room, membership, task, and artifact rules.
- `packages/sqlite` implements domain persistence.
- `apps/hub` owns the loopback HTTP/WebSocket API and operator session.
- `apps/mcp` owns the stdio bridge, local CLI, and harness configuration edits.
- `apps/web` is the human observation and intervention interface.

## Local setup

Use Node.js 22.12 or newer and pnpm 10.

```sh
pnpm install
pnpm -r build
pnpm vitest run
pnpm exec playwright install chromium
pnpm exec playwright test
```

During development, run a focused test first, then the wider suite:

```sh
pnpm vitest run packages/domain/src/collaboration.test.ts
pnpm vitest run apps/mcp
pnpm -r typecheck
pnpm -r build
pnpm format:check
```

Write a failing test before implementing behavior. Use temporary SQLite files
and isolated project directories. End-to-end tests must use separate MCP bridge
processes; do not replace them with direct calls to the hub's domain functions.

## Adding an event type

1. Add the type to the shared protocol enum and event payload schema.
2. Add the domain operation that creates the event and enforce room membership
   and state transitions there.
3. Expose it through the hub route and MCP tool only when agents need that
   operation.
4. Update the observer rendering if the event should be visible to the user.
5. Add schema, domain, adapter, and observer tests for the new behavior.

Keep stored event payloads versioned and JSON serializable. Avoid harness-specific
semantics in shared event types.

## Adding a harness integration

Add a project-scoped config planner under `apps/mcp/src/integrations`, preserve
unrelated configuration, reject conflicting entries, create a backup before
writing, and make removal delete only the Session Bus-managed entry. Add tests
for paths containing spaces, dry-run, backup, removal, and conflicting config.
Document the config path and the portable collaboration loop under
`docs/integrations/`.

## Changes and commits

Keep changes focused and use conventional commit prefixes such as `feat:`,
`fix:`, `docs:`, and `test:`. Before submitting, run formatting, tests,
typechecking, and builds for affected packages. For UI or adapter changes, run
the Playwright and multi-process tests as well.
