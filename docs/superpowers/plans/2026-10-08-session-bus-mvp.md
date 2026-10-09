# Session Bus MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local collaboration bus through which live Claude Code, Codex, and OpenCode sessions can discover one another, form rooms, exchange durable context, coordinate tasks, and appear in a real-time human interface.

**Architecture:** A local Node.js hub owns room state and an append-only SQLite event log. Each harness launches a stdio MCP bridge; that bridge registers one authenticated session with the hub, keeps its token out of model-visible tool arguments, and translates common MCP tools into hub API calls. A React application consumes the same HTTP API and WebSocket event feed for observation and human intervention.

**Tech Stack:** Node.js 22+, TypeScript 6 in strict mode, pnpm workspaces, Biome 2, `@modelcontextprotocol/server` v2, Zod 4, Fastify 5, `@fastify/websocket`, `better-sqlite3`, React 19, Vite 7, Vitest 4, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-session-bus-design.md`

## Global Constraints

- The service listens on loopback only and is local, single-user software.
- Sessions are peers; the hub never plans work or assigns tasks automatically.
- The hub never imports or clones a harness's private transcript.
- Shared context consists only of explicitly published events, decisions, tasks, summaries, and artifact references.
- Sender identity is derived from a server-issued instance token and never from a caller-supplied sender ID.
- Events are persisted before delivery and ordered by a monotonically increasing sequence within each room.
- Delivery is at least once; consumers deduplicate by event ID and resume from cursors.
- Project paths and artifact URIs are data and never grant the hub authority to read files.
- MCP stdio processes write protocol data only to stdout; diagnostics go to stderr.
- Every state-changing request accepts an idempotency key.

## Review Focus

- A forged session ID or a valid token from a non-member must not read or mutate a room; Tasks 5 and 6 include authorization tests.
- Concurrent event writes to one room must produce unique contiguous sequence numbers; Task 4 includes a concurrent persistence test.
- Repeating a mutating call with the same idempotency key must return the original result without another event; Tasks 4 and 6 include replay tests.
- A disconnected consumer must resume after its last cursor without missing events and may safely receive duplicates; Tasks 6 and 10 include reconnect tests.
- Closing a room while another session writes must produce either a committed pre-close event or a rejection, never an event after `room_closed`; Tasks 3 and 4 include transition and transaction tests.

---

## Delivery milestones

The work is split into four reviewable milestones because the specification contains distinct subsystems:

1. **Core bus:** Tasks 1–6 produce a complete HTTP/WebSocket collaboration hub with SQLite persistence.
2. **Agent interface:** Task 7 produces the harness-neutral stdio MCP bridge.
3. **Human interface:** Task 8 produces the live web application.
4. **Harness integration and release:** Tasks 9–10 configure three real harnesses and verify the complete workflow.

Each milestone is runnable and testable before the next begins.

## Planned repository structure

```text
apps/
  hub/                 Fastify HTTP and WebSocket daemon
  mcp/                 per-session stdio MCP bridge and CLI
  web/                 React observer interface
packages/
  protocol/            shared Zod schemas and transport DTOs
  domain/              entities, transitions, ports, and use cases
  sqlite/              SQLite migrations and repository implementation
  test-support/        fixtures and in-process test helpers
tests/e2e/              cross-process collaboration scenarios
docs/integrations/      Claude Code, Codex, and OpenCode setup
```

Dependencies point inward: applications depend on packages; `sqlite` depends on `domain` and `protocol`; `domain` depends only on `protocol`; `protocol` has no project dependency.

### Task 1: Establish the TypeScript workspace and shared protocol

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `biome.json`
- Create: `.gitignore`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/schemas.ts`
- Test: `packages/protocol/src/schemas.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: Zod schemas and inferred types `SessionProfile`, `Room`, `Membership`, `RoomEvent`, `SharedTask`, `Artifact`, `RoomContext`, `EventCursor`, and `ApiError`.

- [ ] **Step 1: Add a failing schema contract test**

```ts
import { describe, expect, it } from "vitest";
import { roomEventSchema, sessionProfileSchema } from "./schemas.js";

describe("protocol schemas", () => {
  it("rejects a session profile with a relative project root", () => {
    expect(() => sessionProfileSchema.parse({
      name: "codex-api",
      harness: { name: "codex", version: "1.0.0" },
      projectRoot: "./app",
      capabilities: ["typescript"],
      currentFocus: "API",
    })).toThrow();
  });

  it("accepts a versioned message event without a caller-selected sequence", () => {
    const event = roomEventSchema.parse({
      id: "018f4f8e-50cf-7d9a-bf55-31bead341234",
      roomId: "018f4f8e-50cf-7d9a-bf55-31bead341235",
      sequence: 1,
      senderId: "018f4f8e-50cf-7d9a-bf55-31bead341236",
      type: "message",
      version: 1,
      payload: { text: "Ready to collaborate" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });
    expect(event.type).toBe("message");
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `pnpm vitest run packages/protocol/src/schemas.test.ts`

Expected: FAIL because the workspace and `schemas.ts` do not exist.

- [ ] **Step 3: Create the workspace configuration**

Use ESM packages, `moduleResolution: "Bundler"`, `strict: true`, `noUncheckedIndexedAccess: true`, and scripts named `build`, `typecheck`, `test`, `lint`, `format`, and `format:check`. Pin the package manager through `"packageManager": "pnpm@10"` and require Node `>=22.12`.

The root scripts must delegate through `pnpm -r`; `lint`, `format`, and `format:check` invoke Biome at the repository root. `vitest.workspace.ts` discovers `packages/*` and `apps/*` projects. Configure Biome for two-space indentation, double quotes, organized imports, and recommended lint rules. Ignore `node_modules`, `dist`, `.session-bus`, `playwright-report`, and `test-results`.

- [ ] **Step 4: Implement the versioned protocol schemas**

```ts
import { z } from "zod/v4";

export const uuidSchema = z.uuid();
export const absolutePathSchema = z.string().refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
  "projectRoot must be absolute",
);
export const sessionProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  harness: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  projectRoot: absolutePathSchema,
  capabilities: z.array(z.string().trim().min(1)).max(32).default([]),
  currentFocus: z.string().max(500).default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export const roomEventSchema = z.object({
  id: uuidSchema,
  roomId: uuidSchema,
  sequence: z.int().positive(),
  senderId: uuidSchema,
  type: z.enum([
    "message", "question", "decision", "task_created", "task_updated",
    "artifact_published", "conflict_reported", "member_invited",
    "member_joined", "member_left", "room_closed",
  ]),
  version: z.literal(1),
  payload: z.record(z.string(), z.unknown()),
  replyToEventId: uuidSchema.optional(),
  taskId: uuidSchema.optional(),
  createdAt: z.iso.datetime(),
});

export type SessionProfile = z.infer<typeof sessionProfileSchema>;
export type RoomEvent = z.infer<typeof roomEventSchema>;
```

Define the remaining schemas from section 5 of the spec with camelCase JSON fields. Export every schema and inferred type from `packages/protocol/src/index.ts`. Model all statuses as closed Zod enums.

- [ ] **Step 5: Run protocol tests and type checking**

Run: `pnpm vitest run packages/protocol/src/schemas.test.ts && pnpm --filter @session-bus/protocol typecheck`

Expected: both commands PASS.

- [ ] **Step 6: Commit the protocol foundation**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts biome.json .gitignore packages/protocol
git commit -m "feat: define session bus protocol"
```

### Task 2: Implement session, invitation, and membership rules

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/errors.ts`
- Create: `packages/domain/src/clock.ts`
- Create: `packages/domain/src/ids.ts`
- Create: `packages/domain/src/repositories.ts`
- Create: `packages/domain/src/sessions.ts`
- Create: `packages/domain/src/rooms.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/src/rooms.test.ts`

**Interfaces:**
- Consumes: protocol types from Task 1.
- Produces: `SessionRepository`, `RoomRepository`, `UnitOfWork`, `registerSession()`, `createRoom()`, `inviteSessions()`, and `respondToInvitation()`.

- [ ] **Step 1: Write failing room lifecycle tests**

```ts
it("allows only an active room member to invite another session", async () => {
  const { service, alice, bob, mallory } = fixture();
  const room = await service.createRoom(alice.auth, {
    title: "Ship auth", objective: "Implement and review authentication",
    idempotencyKey: "create-room-1",
  });
  await expect(service.inviteSessions(mallory.auth, {
    roomId: room.id, sessionIds: [bob.id], idempotencyKey: "invite-1",
  })).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_REQUIRED" });
});

it("does not expose full room context before an invitation is accepted", async () => {
  const { service, alice, bob } = fixture();
  const room = await createRoomAndInvite(service, alice, bob);
  await expect(service.getRoomContext(bob.auth, room.id)).rejects.toMatchObject({
    code: "INVITATION_NOT_ACCEPTED",
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm vitest run packages/domain/src/rooms.test.ts`

Expected: FAIL because domain services and repository ports are absent.

- [ ] **Step 3: Define repository and transaction ports**

```ts
export interface UnitOfWork {
  sessions: SessionRepository;
  rooms: RoomRepository;
  events: EventRepository;
  tasks: TaskRepository;
  artifacts: ArtifactRepository;
  idempotency: IdempotencyRepository;
}

export interface Database {
  read<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
  write<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
```

Repository methods accept already validated domain values. Define `Clock.now(): Date` and `IdGenerator.next(): string` so tests use deterministic time and IDs.

- [ ] **Step 4: Implement identity and membership use cases**

`registerSession(profile)` creates a random instance token, stores only its SHA-256 hash, and returns the plaintext once. Authentication hashes the presented token and loads the associated session. `createRoom()` makes the creator an active member in the same transaction. `inviteSessions()` requires active membership and creates pending memberships. `respondToInvitation()` may be called only by the invited session and transitions once to `active` or `declined`.

Represent expected failures with:

```ts
export class DomainError extends Error {
  constructor(
    readonly code: "AUTHENTICATION_FAILED" | "ROOM_NOT_FOUND" |
      "ROOM_MEMBERSHIP_REQUIRED" | "INVITATION_NOT_ACCEPTED" |
      "INVALID_TRANSITION" | "ROOM_CLOSED" | "IDEMPOTENCY_CONFLICT",
    message: string,
  ) { super(message); }
}
```

- [ ] **Step 5: Add tests for expired presence and repeated invitation responses**

Prove that heartbeat expiry changes discovery status to `offline` without removing memberships, and that a second response to the same invitation fails with `INVALID_TRANSITION`.

- [ ] **Step 6: Run all domain tests and type checking**

Run: `pnpm vitest run packages/domain && pnpm --filter @session-bus/domain typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the membership domain**

```bash
git add packages/domain
git commit -m "feat: add session and room membership rules"
```

### Task 3: Implement events, tasks, artifacts, and room closure

**Files:**
- Create: `packages/domain/src/events.ts`
- Create: `packages/domain/src/tasks.ts`
- Create: `packages/domain/src/artifacts.ts`
- Modify: `packages/domain/src/repositories.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/collaboration.test.ts`

**Interfaces:**
- Consumes: authenticated membership services and repositories from Task 2.
- Produces: `sendMessage()`, `listEvents()`, `createTask()`, `claimTask()`, `updateTask()`, `publishArtifact()`, `leaveRoom()`, and `closeRoom()`.

- [ ] **Step 1: Write failing collaboration transition tests**

```ts
it("permits only one session to claim an open task", async () => {
  const { service, room, alice, bob } = await activeRoomFixture();
  const task = await service.createTask(alice.auth, {
    roomId: room.id, title: "Review schema", description: "Check migrations",
    idempotencyKey: "task-1",
  });
  await service.claimTask(bob.auth, { taskId: task.id, idempotencyKey: "claim-1" });
  await expect(service.claimTask(alice.auth, {
    taskId: task.id, idempotencyKey: "claim-2",
  })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
});

it("never accepts events after room closure", async () => {
  const { service, room, alice } = await activeRoomFixture();
  await service.closeRoom(alice.auth, {
    roomId: room.id, summary: "Work complete", idempotencyKey: "close-1",
  });
  await expect(service.sendMessage(alice.auth, {
    roomId: room.id, text: "late", idempotencyKey: "message-late",
  })).rejects.toMatchObject({ code: "ROOM_CLOSED" });
});
```

- [ ] **Step 2: Run the collaboration tests and verify they fail**

Run: `pnpm vitest run packages/domain/src/collaboration.test.ts`

Expected: FAIL because the collaboration use cases are missing.

- [ ] **Step 3: Implement event and task transitions**

Every mutation runs inside `Database.write()`, validates active membership and open room status, changes aggregate state, then appends one immutable event. Task transitions are:

```text
open -> claimed | cancelled
claimed -> blocked | completed | cancelled
blocked -> claimed | cancelled
completed and cancelled -> terminal
```

Only the owner may block or complete a claimed task. Any active member may create a task or report a conflict. A member may leave while owning incomplete tasks; those tasks atomically return to `open` before `member_left` is appended.

- [ ] **Step 4: Implement artifact references and room closure**

Validate artifact kinds and URI syntax without dereferencing the URI. `closeRoom()` requires a non-empty summary, changes status to `closed`, persists the final summary, and appends `room_closed` atomically. The first successful close wins; later mutations fail with `ROOM_CLOSED`.

- [ ] **Step 5: Add authorization and terminal-state tests**

Test non-members, invited-but-inactive members, task ownership, invalid artifact URIs, leave-with-owned-task behavior, and writes after closure. Include a race test at the service port showing only one of `closeRoom` and a concurrent `sendMessage` may commit after the room lock is acquired.

- [ ] **Step 6: Run the domain suite**

Run: `pnpm vitest run packages/domain && pnpm --filter @session-bus/domain typecheck`

Expected: PASS.

- [ ] **Step 7: Commit collaboration behavior**

```bash
git add packages/domain
git commit -m "feat: add room collaboration lifecycle"
```

### Task 4: Add transactional SQLite persistence

**Files:**
- Create: `packages/sqlite/package.json`
- Create: `packages/sqlite/tsconfig.json`
- Create: `packages/sqlite/src/migrations/001_initial.sql`
- Create: `packages/sqlite/src/database.ts`
- Create: `packages/sqlite/src/repositories.ts`
- Create: `packages/sqlite/src/codec.ts`
- Create: `packages/sqlite/src/index.ts`
- Test: `packages/sqlite/src/database.test.ts`
- Test: `packages/sqlite/src/concurrency.test.ts`

**Interfaces:**
- Consumes: `Database`, repository ports, and protocol types from Tasks 1–3.
- Produces: `openSqliteDatabase({ filename }): Database & AsyncDisposable` and `migrate()`.

- [ ] **Step 1: Write failing persistence contract tests**

```ts
it("allocates contiguous per-room event sequences under concurrent writes", async () => {
  const fixture = await sqliteFixture();
  const room = await fixture.activeRoom();
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    fixture.service.sendMessage(fixture.alice.auth, {
      roomId: room.id, text: `message-${index}`, idempotencyKey: `m-${index}`,
    }),
  ));
  const events = await fixture.service.listEvents(fixture.alice.auth, room.id, 0, 50);
  expect(events.map((event) => event.sequence)).toEqual(
    Array.from({ length: events.length }, (_, index) => index + 1),
  );
});

it("replays the original response for a repeated idempotency key", async () => {
  const fixture = await sqliteFixture();
  const input = { title: "Room", objective: "Test", idempotencyKey: "same" };
  const first = await fixture.service.createRoom(fixture.alice.auth, input);
  const second = await fixture.service.createRoom(fixture.alice.auth, input);
  expect(second).toEqual(first);
  expect(await fixture.countRooms()).toBe(1);
});
```

- [ ] **Step 2: Run the SQLite tests and verify they fail**

Run: `pnpm vitest run packages/sqlite`

Expected: FAIL because the adapter and migration do not exist.

- [ ] **Step 3: Create the normalized schema and migration runner**

Create tables for `sessions`, `rooms`, `memberships`, `events`, `tasks`, `artifacts`, and `idempotency_keys`. Use foreign keys, `CHECK` constraints for closed enums, a unique `(room_id, sequence)` index, a unique `(actor_session_id, idempotency_key)` index, and indexes for unread room events and pending invitations. Enable `foreign_keys`, WAL mode, and a 5-second busy timeout.

Run migrations inside `BEGIN IMMEDIATE`; track them in `schema_migrations(version, applied_at)`.

- [ ] **Step 4: Implement repositories and transaction boundaries**

Use `better-sqlite3` prepared statements. `Database.write()` uses `BEGIN IMMEDIATE` so room sequence allocation reads `MAX(sequence) + 1` and inserts while holding the write lock. Roll back on any thrown error. Store event payloads and adapter metadata as canonical JSON; validate decoded records through Task 1 schemas before returning them.

- [ ] **Step 5: Test rollback, closure races, cursors, and malformed stored JSON**

Verify that failed domain mutations leave no partial rows, a close/write race has no event after `room_closed`, cursor queries return `sequence > cursor` in ascending order, and corrupted JSON fails with a typed persistence error rather than leaking a `SyntaxError`.

- [ ] **Step 6: Run persistence and domain suites**

Run: `pnpm vitest run packages/domain packages/sqlite && pnpm -r typecheck`

Expected: PASS.

- [ ] **Step 7: Commit SQLite persistence**

```bash
git add packages/sqlite
git commit -m "feat: persist collaboration state in sqlite"
```

### Task 5: Expose session registration, authentication, discovery, and presence over HTTP

**Files:**
- Create: `apps/hub/package.json`
- Create: `apps/hub/tsconfig.json`
- Create: `apps/hub/src/config.ts`
- Create: `apps/hub/src/auth.ts`
- Create: `apps/hub/src/operator-auth.ts`
- Create: `apps/hub/src/errors.ts`
- Create: `apps/hub/src/routes/sessions.ts`
- Create: `apps/hub/src/app.ts`
- Create: `apps/hub/src/main.ts`
- Test: `apps/hub/src/routes/sessions.test.ts`

**Interfaces:**
- Consumes: domain services and SQLite adapter from Tasks 2 and 4.
- Produces: `buildHubApp(dependencies)`, agent bearer authentication, same-origin operator authentication, `POST /api/v1/sessions`, `POST /api/v1/sessions/heartbeat`, `PATCH /api/v1/sessions/me`, and `GET /api/v1/sessions`.

- [ ] **Step 1: Write failing HTTP authentication tests**

```ts
it("derives the current session from a bearer token", async () => {
  const app = await hubFixture();
  const registered = await app.inject({
    method: "POST", url: "/api/v1/sessions", payload: validProfile,
  });
  const { instanceToken, session } = registered.json();
  const response = await app.inject({
    method: "GET", url: "/api/v1/sessions",
    headers: { authorization: `Bearer ${instanceToken}` },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().items[0].id).toBe(session.id);
});

it("rejects a forged session header", async () => {
  const app = await hubFixture();
  const response = await app.inject({
    method: "GET", url: "/api/v1/sessions",
    headers: { "x-session-id": crypto.randomUUID() },
  });
  expect(response.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run the route tests and verify they fail**

Run: `pnpm vitest run apps/hub/src/routes/sessions.test.ts`

Expected: FAIL because the Fastify application is absent.

- [ ] **Step 3: Implement validated configuration and loopback binding**

Parse `SESSION_BUS_HOST`, `SESSION_BUS_PORT`, `SESSION_BUS_DB`, and `SESSION_BUS_PRESENCE_TTL_MS` with Zod. Default to `127.0.0.1`, `7345`, `.session-bus/session-bus.sqlite`, and `30000`. Reject non-loopback hosts unless a future explicit remote-mode feature exists.

- [ ] **Step 4: Implement session routes and error mapping**

Validate every body, query, and response with shared schemas. Registration is the only unauthenticated mutation. All other routes require `Authorization: Bearer <instanceToken>`. Map domain error codes to stable JSON:

```json
{ "error": { "code": "AUTHENTICATION_FAILED", "message": "Invalid session token" } }
```

Never log bearer tokens or registration responses. Discovery reports effective presence from the heartbeat lease.

The hub creates one in-memory operator session when serving the same-origin web application. It issues an `HttpOnly`, `SameSite=Strict` cookie from the HTML entry route, rejects API requests whose `Origin` is not the hub origin, and requires the cookie on operator endpoints. Agent bearer tokens cannot call operator-only endpoints, and operator cookies cannot impersonate an agent.

- [ ] **Step 5: Add malformed input, expiry, and secret-leak tests**

Test missing/invalid bearer tokens, relative project roots, duplicate names, expired heartbeat leases, cross-origin operator requests, missing operator cookies, and logger output redaction. Verify the response does not include token hashes or another session's token.

- [ ] **Step 6: Run hub session tests**

Run: `pnpm vitest run apps/hub/src/routes/sessions.test.ts && pnpm --filter @session-bus/hub typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the authenticated hub shell**

```bash
git add apps/hub
git commit -m "feat: expose authenticated session presence API"
```

### Task 6: Expose rooms, collaboration events, cursors, and WebSocket subscriptions

**Files:**
- Create: `apps/hub/src/routes/rooms.ts`
- Create: `apps/hub/src/routes/events.ts`
- Create: `apps/hub/src/routes/tasks.ts`
- Create: `apps/hub/src/routes/artifacts.ts`
- Create: `apps/hub/src/realtime/event-broker.ts`
- Create: `apps/hub/src/realtime/websocket.ts`
- Modify: `apps/hub/src/app.ts`
- Test: `apps/hub/src/routes/collaboration.test.ts`
- Test: `apps/hub/src/realtime/websocket.test.ts`

**Interfaces:**
- Consumes: authenticated request identity from Task 5 and collaboration services from Task 3.
- Produces: versioned room/task/artifact endpoints, `GET /api/v1/events/wait`, and `GET /api/v1/ws`.

- [ ] **Step 1: Write failing authorization and idempotency API tests**

```ts
it("blocks a valid non-member token from reading room events", async () => {
  const { app, room, mallory } = await roomHttpFixture();
  const response = await app.inject({
    method: "GET", url: `/api/v1/rooms/${room.id}/events?after=0`,
    headers: bearer(mallory.token),
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().error.code).toBe("ROOM_MEMBERSHIP_REQUIRED");
});

it("returns the same event when a message request is replayed", async () => {
  const fixture = await roomHttpFixture();
  const request = {
    method: "POST" as const,
    url: `/api/v1/rooms/${fixture.room.id}/messages`,
    headers: { ...bearer(fixture.alice.token), "idempotency-key": "msg-1" },
    payload: { type: "message", text: "hello" },
  };
  const first = await fixture.app.inject(request);
  const second = await fixture.app.inject(request);
  expect(second.json()).toEqual(first.json());
});
```

- [ ] **Step 2: Run collaboration route tests and verify they fail**

Run: `pnpm vitest run apps/hub/src/routes/collaboration.test.ts`

Expected: FAIL because collaboration routes are absent.

- [ ] **Step 3: Implement room, invitation, message, task, and artifact routes**

Use plural REST resources under `/api/v1`. Require `Idempotency-Key` for every POST/PATCH mutation. Return `201` for first creation, `200` for an idempotent replay, `409` for transition conflicts, `403` for membership failures, and `410` for writes to closed rooms.

`GET /rooms/:id/context` returns the context packet. `GET /rooms/:id/events?after=<sequence>&limit=<1..200>` returns ordered events plus `nextCursor`.

Add operator-authenticated read routes for the web application and `POST /api/v1/operator/rooms/:id/messages`. A human message is persisted as a normal versioned event whose sender is the fixed local operator actor; the endpoint cannot claim a session identity.

- [ ] **Step 4: Implement a commit-aware local event broker**

```ts
export interface EventBroker {
  publish(event: RoomEvent): void;
  subscribe(filter: { sessionId: string; afterByRoom: Record<string, number> }): AsyncIterable<RoomEvent>;
}
```

Publish only after the database transaction commits. On subscription, first query persisted events after each cursor, then attach to live notifications, then query once more to close the race between backlog and subscription. Deduplicate that overlap by event ID.

- [ ] **Step 5: Implement long polling and authenticated WebSocket delivery**

`GET /events/wait?timeoutMs=25000` waits for invitations or active-room events and returns an empty list on timeout. Cap timeout at 30 seconds. WebSocket clients authenticate with a short-lived ticket obtained from `POST /api/v1/ws-tickets`; tokens never appear in URLs. The first client frame supplies per-room cursors, and each server frame is `{ "type": "event", "event": RoomEvent }`.

- [ ] **Step 6: Test reconnect, slow consumers, and close/write ordering**

Test backlog followed by live delivery with no gaps, duplicate suppression at the handoff boundary, invalid/expired WebSocket tickets, a consumer reconnecting from its last cursor, bounded subscriber queues disconnecting a slow consumer with code `1013`, and room closure racing with a message.

- [ ] **Step 7: Run the complete core bus suite**

Run: `pnpm vitest run packages apps/hub && pnpm -r typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the core collaboration hub**

```bash
git add apps/hub
git commit -m "feat: add realtime collaboration hub"
```

### Task 7: Build the harness-neutral stdio MCP bridge

**Files:**
- Create: `apps/mcp/package.json`
- Create: `apps/mcp/tsconfig.json`
- Create: `apps/mcp/src/config.ts`
- Create: `apps/mcp/src/hub-client.ts`
- Create: `apps/mcp/src/session.ts`
- Create: `apps/mcp/src/tools.ts`
- Create: `apps/mcp/src/server.ts`
- Create: `apps/mcp/src/main.ts`
- Test: `apps/mcp/src/tools.test.ts`
- Test: `apps/mcp/src/stdio.test.ts`

**Interfaces:**
- Consumes: hub HTTP API from Tasks 5–6 and protocol schemas from Task 1.
- Produces: executable `session-bus-mcp` and the MCP tools listed in spec section 7.

- [ ] **Step 1: Write a failing in-process MCP tool contract test**

```ts
it("registers one bridge identity and never exposes its token as a tool argument", async () => {
  const hub = fakeHubClient();
  const server = await buildMcpServer({
    hub,
    profile: { name: "codex-api", harness: { name: "codex", version: "1" },
      projectRoot: "/repo", capabilities: [], currentFocus: "" },
  });
  expect(hub.registerSession).toHaveBeenCalledOnce();
  const tools = await listTools(server);
  expect(tools.find((tool) => tool.name === "send_message")?.inputSchema)
    .not.toHaveProperty("properties.instanceToken");
  expect(tools.find((tool) => tool.name === "send_message")?.inputSchema)
    .not.toHaveProperty("properties.senderId");
});
```

- [ ] **Step 2: Run the MCP tests and verify they fail**

Run: `pnpm vitest run apps/mcp/src/tools.test.ts`

Expected: FAIL because the bridge is absent.

- [ ] **Step 3: Implement bridge configuration and session lifetime**

Read `SESSION_BUS_URL`, `SESSION_BUS_SESSION_NAME`, `SESSION_BUS_HARNESS`, `SESSION_BUS_HARNESS_VERSION`, `SESSION_BUS_PROJECT_ROOT`, and optional comma-separated capabilities. Require an absolute project root. Register once at process startup, retain the instance token only in memory, heartbeat every 10 seconds, mark the session `away` during graceful shutdown when possible, and stop on `SIGINT`, `SIGTERM`, or stdin closure.

- [ ] **Step 4: Register the MCP tools with Zod schemas**

Use `McpServer` and `serveStdio` from the official v2 SDK. Implement the exact tools from spec section 7. Tool arguments contain domain inputs but never sender identity or credentials. Return both concise text content for the model and `structuredContent` validated by the shared output schema.

For expected hub failures, return `isError: true` with a stable code and actionable text. Unexpected failures use `INTERNAL_ERROR` and log details only to stderr.

- [ ] **Step 5: Add collaboration-oriented server instructions**

The MCP server instructions tell the connected agent to register its current focus, check invitations, accept only relevant rooms, call `get_room_context` after joining, communicate decisions and blockers, publish results, and call `wait_for_events` while actively collaborating. They explicitly prohibit sharing secrets or private transcripts.

- [ ] **Step 6: Test every tool and the real stdio boundary**

Use a fake `HubClient` for one contract test per tool. Spawn the compiled bridge for a stdio smoke test, connect with `@modelcontextprotocol/client` using automatic protocol negotiation, list tools, call `list_sessions`, and assert stdout contains only valid MCP frames even when the hub returns an error.

- [ ] **Step 7: Run MCP, core, and build checks**

Run: `pnpm vitest run apps/mcp packages apps/hub && pnpm -r typecheck && pnpm -r build`

Expected: PASS.

- [ ] **Step 8: Commit the MCP bridge**

```bash
git add apps/mcp
git commit -m "feat: add harness-neutral MCP bridge"
```

### Task 8: Build the real-time observer web application

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/realtime/use-room-stream.ts`
- Create: `apps/web/src/components/session-list.tsx`
- Create: `apps/web/src/components/room-list.tsx`
- Create: `apps/web/src/components/room-view.tsx`
- Create: `apps/web/src/components/task-board.tsx`
- Create: `apps/web/src/components/context-panel.tsx`
- Create: `apps/web/src/styles.css`
- Test: `apps/web/src/app.test.tsx`
- Test: `apps/web/src/realtime/use-room-stream.test.tsx`

**Interfaces:**
- Consumes: hub HTTP API, WebSocket protocol, and shared protocol schemas.
- Produces: a responsive local UI showing sessions, rooms, events, shared context, tasks, decisions, and artifacts.

- [ ] **Step 1: Write the failing observer workflow test**

```tsx
it("shows a new agent message without refreshing", async () => {
  const realtime = createFakeRealtime();
  render(<App api={fakeApi} realtime={realtime} />);
  await userEvent.click(await screen.findByRole("button", { name: /ship auth/i }));
  act(() => realtime.emit(messageEvent({ text: "Schema review complete" })));
  expect(await screen.findByText("Schema review complete")).toBeVisible();
});
```

- [ ] **Step 2: Run the UI test and verify it fails**

Run: `pnpm vitest run apps/web/src/app.test.tsx`

Expected: FAIL because the web application is absent.

- [ ] **Step 3: Implement the API and real-time state boundary**

The API client uses same-origin credentials and validates every response with protocol schemas. `useRoomStream` loads the room context, opens an operator-ticketed WebSocket, applies events by `(roomId, sequence)`, ignores known event IDs, detects sequence gaps, and repairs a gap through `GET /rooms/:id/events?after=<lastSequence>` before applying later live events.

- [ ] **Step 4: Implement the three-pane application**

Create a left sidebar for session presence, a room list with unread counts, and a room detail view. Room detail includes a chronological event feed, participants, objective and summary, task board, decisions, and artifact links. Display event type and sender clearly without exposing internal IDs as primary labels.

Add a compact human message composer. Human messages go through a dedicated local human actor endpoint and appear as normal `message` events.

- [ ] **Step 5: Add accessible loading, empty, error, and reconnect states**

Use semantic landmarks and buttons, visible keyboard focus, `aria-live="polite"` for connection state, and text labels in addition to colors. Show offline sessions without deleting them. Preserve the selected room during reconnect and display a reconnecting banner until cursor recovery finishes.

- [ ] **Step 6: Test gaps, duplicates, offline sessions, and keyboard navigation**

Test a missing sequence repaired through HTTP, a duplicate event ignored, a session becoming offline, an empty room, a closed room with disabled composer, WebSocket reconnection, and keyboard navigation through session and room lists.

- [ ] **Step 7: Run UI and production build checks**

Run: `pnpm vitest run apps/web && pnpm --filter @session-bus/web typecheck && pnpm --filter @session-bus/web build`

Expected: PASS and Vite emits `apps/web/dist`.

- [ ] **Step 8: Commit the observer interface**

```bash
git add apps/web
git commit -m "feat: add realtime collaboration interface"
```

### Task 9: Add installation and harness integration commands

**Files:**
- Create: `apps/mcp/src/cli.ts`
- Create: `apps/mcp/src/integrations/types.ts`
- Create: `apps/mcp/src/integrations/claude-code.ts`
- Create: `apps/mcp/src/integrations/codex.ts`
- Create: `apps/mcp/src/integrations/opencode.ts`
- Create: `apps/mcp/src/integrations/detect.ts`
- Create: `docs/integrations/claude-code.md`
- Create: `docs/integrations/codex.md`
- Create: `docs/integrations/opencode.md`
- Modify: `apps/mcp/package.json`
- Modify: `README.md`
- Test: `apps/mcp/src/integrations/integrations.test.ts`

**Interfaces:**
- Consumes: built `session-bus-mcp` executable from Task 7.
- Produces: `session-bus doctor`, `session-bus install <harness>`, `session-bus hub`, and reversible per-harness configuration edits.

- [ ] **Step 1: Write failing integration rendering tests**

```ts
it.each(["claude-code", "codex", "opencode"] as const)(
  "renders a project-scoped %s MCP entry with an absolute executable",
  (harness) => {
    const integration = integrations[harness];
    const edit = integration.planInstall({
      executable: "/opt/session-bus/bin/session-bus-mcp",
      projectRoot: "/repo",
      hubUrl: "http://127.0.0.1:7345",
    });
    expect(edit.preview).toContain("/opt/session-bus/bin/session-bus-mcp");
    expect(edit.preview).toContain("/repo");
    expect(edit.scope).toBe("project");
  },
);
```

- [ ] **Step 2: Run integration tests and verify they fail**

Run: `pnpm vitest run apps/mcp/src/integrations/integrations.test.ts`

Expected: FAIL because integration planners are absent.

- [ ] **Step 3: Implement non-destructive detection and installation planning**

Each integration has `detect()`, `planInstall()`, `applyInstall()`, and `remove()` methods. Parse existing configuration with a format-preserving parser appropriate to JSON, JSONC, TOML, or YAML. Never overwrite an unknown existing `session-bus` entry. Before mutation, write a sibling timestamped backup and print the exact target and planned diff. `--dry-run` performs no writes.

- [ ] **Step 4: Implement the operator CLI**

`session-bus hub` starts the daemon. `session-bus doctor` checks Node version, loopback reachability, database writability, bridge executable location, and harness configuration. `session-bus install <harness> --project <absolute-path>` applies one project-scoped integration. Add `--dry-run` and `--remove`.

- [ ] **Step 5: Write exact harness documentation**

For each harness, document prerequisites, install command, generated configuration location, startup sequence, how a session chooses its display name and capabilities, how to verify `list_sessions`, and how to remove the integration. Document the portable collaboration loop: update focus, inspect invitations, join, load room context, communicate, then wait for events.

- [ ] **Step 6: Test preservation, backup, removal, and paths with spaces**

Use temporary home and project directories. Verify unrelated user configuration remains byte-for-byte equivalent after parse/serialize where the format permits, backups are created before writes, removal deletes only the managed entry, existing conflicting entries fail safely, and executable/project paths with spaces remain valid.

- [ ] **Step 7: Run integration and documentation checks**

Run: `pnpm vitest run apps/mcp && pnpm -r typecheck && pnpm -r build`

Expected: PASS.

- [ ] **Step 8: Commit harness integrations**

```bash
git add apps/mcp docs/integrations README.md
git commit -m "feat: add harness installation workflows"
```

### Task 10: Verify the complete three-session MVP and prepare the repository for release

**Files:**
- Create: `packages/test-support/package.json`
- Create: `packages/test-support/src/hub-process.ts`
- Create: `packages/test-support/src/mcp-session.ts`
- Create: `tests/e2e/collaboration.test.ts`
- Create: `tests/e2e/reconnect.test.ts`
- Create: `tests/e2e/web-observer.spec.ts`
- Create: `playwright.config.ts`
- Create: `.github/workflows/ci.yml`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: every executable and public API from Tasks 1–9.
- Produces: reproducible end-to-end verification, continuous integration, contributor setup, and release-ready documentation.

- [x] **Step 1: Write the failing three-session end-to-end scenario**

```ts
it("lets three independent MCP sessions complete a room lifecycle", async () => {
  await using system = await startTestSystem();
  await using alice = await system.startMcpSession("codex-api", "codex");
  await using bob = await system.startMcpSession("claude-review", "claude-code");
  await using carol = await system.startMcpSession("opencode-tests", "opencode");

  const room = await alice.call("create_room", {
    title: "Authentication", objective: "Implement and verify auth",
    idempotencyKey: "room-1",
  });
  await alice.call("invite_sessions", {
    roomId: room.id, sessionIds: [bob.sessionId, carol.sessionId],
    idempotencyKey: "invite-1",
  });
  await bob.call("respond_to_invitation", {
    roomId: room.id, response: "accept", idempotencyKey: "bob-accept",
  });
  await carol.call("respond_to_invitation", {
    roomId: room.id, response: "accept", idempotencyKey: "carol-accept",
  });
  const task = await alice.call("create_task", {
    roomId: room.id, title: "Review schema", description: "Verify DB changes",
    idempotencyKey: "task-1",
  });
  await bob.call("claim_task", { taskId: task.id, idempotencyKey: "claim-1" });
  await bob.call("update_task", {
    taskId: task.id, status: "completed", resultSummary: "Schema approved",
    idempotencyKey: "complete-1",
  });
  await alice.call("close_room", {
    roomId: room.id, summary: "Implementation and review complete",
    idempotencyKey: "close-1",
  });
  expect((await carol.call("get_room_context", { roomId: room.id })).room.status)
    .toBe("closed");
});
```

- [x] **Step 2: Run the end-to-end test and verify the missing harness failure**

Run: `pnpm vitest run tests/e2e/collaboration.test.ts`

Expected: FAIL because cross-process test support is absent.

- [x] **Step 3: Implement isolated process fixtures**

Start the hub on an OS-assigned loopback port with a temporary SQLite file. Spawn each MCP bridge as a separate process and connect through the official MCP client stdio transport. Capture stderr separately, enforce a 10-second startup timeout, and ensure `AsyncDisposable` cleanup terminates child processes and closes the database after every test.

- [x] **Step 4: Implement reconnect and observer browser scenarios**

The reconnect test disconnects Bob after event sequence N, sends two messages, reconnects with cursor N, and asserts both messages arrive in order without losing later live events. The Playwright scenario opens the web app, observes all three sessions, watches invitations and task completion appear without reload, and verifies the closed-room summary.

- [x] **Step 5: Add CI and contributor documentation**

CI runs on Linux with Node 22 and pnpm 10: frozen install, `pnpm format:check`, lint, typecheck, unit/integration tests, build, then Playwright with its Chromium dependency. `CONTRIBUTING.md` documents architecture boundaries, TDD commands, commit expectations, and how to add an event type or harness integration. `SECURITY.md` explains the loopback-only trust boundary and private vulnerability reporting.

- [x] **Step 6: Finish the README quick start**

Document installation, `session-bus hub`, opening the local UI, project-scoped harness installation, starting two sessions, discovering peers, creating a room, and observing collaboration. Include an architecture diagram and clearly label the project as local, single-user, and pre-1.0.

- [x] **Step 7: Run the complete verification matrix**

Run: `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm vitest run && pnpm -r build && pnpm playwright test`

Expected: every command exits 0; the end-to-end scenario uses three separate MCP bridge processes; Playwright observes the complete room lifecycle.

- [x] **Step 8: Perform the manual cross-harness acceptance**

Start the hub and UI, then connect real Codex and OpenCode sessions using generated project configuration. Verify discovery, room invitations, a threaded question and answer, a completed task, a third participating session, and observer rendering. Record harness names, versions, commands, and results in `docs/acceptance/2026-10-08-mvp.md`. Claude Code was attempted but its OAuth session had expired; it was not needed for the two-vendor acceptance.

- [x] **Step 9: Commit the verified MVP**

```bash
git add packages/test-support tests playwright.config.ts .github CONTRIBUTING.md SECURITY.md README.md docs/acceptance
git commit -m "test: verify end-to-end session collaboration"
```

## Execution order and release gate

Execute tasks strictly in order because later tasks depend on interfaces fixed by earlier tasks. Review and merge each delivery milestone only after its full command passes. The MVP may be tagged `v0.1.0` only after Task 10's automated matrix passes and the manual acceptance record contains two different real harnesses plus a third participating session.
