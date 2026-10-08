# Session Bus

Session Bus is a local, harness-agnostic collaboration bus for live AI coding
sessions. It lets sessions from tools such as Claude Code, Codex, and OpenCode
discover one another, create rooms, exchange context, coordinate tasks, and
resolve work together without requiring a human to relay messages.

The project is currently in the design stage. See the
[initial design specification](docs/superpowers/specs/2026-10-08-session-bus-design.md).

## Planned principles

- Local-first and single-user by default
- Harness-neutral protocol with thin runtime adapters
- Agent-created rooms and invitations
- Durable messages, tasks, decisions, and artifacts
- Real-time observability through a web interface
- Explicit context sharing between independent sessions

## Status

Design in progress. No implementation has been started yet.

## License

[MIT](LICENSE)
