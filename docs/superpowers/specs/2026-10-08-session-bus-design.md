# Session Bus: Initial Design

**Date:** 2026-10-08  
**Status:** Draft for review

## 1. Purpose

Session Bus is a local communication and coordination layer for live AI coding
sessions. A Claude Code session, Codex session, OpenCode session, or another
compatible harness can register itself, discover other sessions, create a room,
invite peers, and collaborate without a human copying context between terminals.

The sessions are peers. Session Bus delivers and records collaboration events;
it does not centrally plan the work or choose which agent should perform it.

## 2. Goals

The first version must let live sessions:

1. Register an identity and advertise their current capabilities and focus.
2. Discover other available local sessions.
3. Create rooms and invite one or more sessions.
4. Accept or reject invitations.
5. Exchange messages and structured context in a room.
6. Create, claim, update, and complete shared tasks.
7. Publish decisions and artifacts.
8. Receive new activity while the harness session remains open.
9. Let a human observe rooms and intervene through a real-time web interface.

## 3. Non-goals for the first version

- Remote or internet-facing operation
- Multi-user accounts and organization management
- Running or spawning coding harnesses
- Full transcript replication between different harnesses
- Automatic merge-conflict resolution
- A central planning agent or mandatory supervisor
- Cloud synchronization

## 4. System model

The system has four major parts:

### 4.1 Local hub

A long-running local daemon owns canonical state, persistence, event ordering,
room membership, and delivery acknowledgements. It exposes MCP to sessions, a
WebSocket event stream, and an HTTP API for the web application.

### 4.2 MCP interface

MCP is the universal interface available to participating agents. It provides
tools for registration, discovery, room membership, messaging, shared tasks,
artifacts, and event waiting.

### 4.3 Harness adapters

A thin adapter handles runtime-specific behavior for each supported harness. It
maintains presence and delivers incoming events to an open session using the
best mechanism that harness supports. A long-polling MCP tool is the portable
fallback when immediate delivery is unavailable.

Adapters must not change the common room or message semantics.

### 4.4 Web application

The web application is an observability and intervention surface. It shows
available sessions, rooms, messages, tasks, decisions, artifacts, and delivery
state in real time. It may send a human message into a room, but it is not the
orchestrator.

## 5. Core entities

### Session

A currently registered harness session.

- `id`: server-generated UUID
- `instance_token`: secret used to authenticate subsequent calls
- `name`: human-readable name
- `harness`: harness name and version
- `project_root`: canonical local project path
- `capabilities`: free-form capability tags
- `current_focus`: short agent-authored description
- `status`: `available`, `busy`, `away`, or `offline`
- `last_seen_at`: last heartbeat or authenticated activity
- `metadata`: adapter-specific, non-secret metadata

### Room

A persistent collaboration space created by a session.

- `id`: server-generated UUID
- `title`
- `objective`
- `status`: `open`, `completed`, or `closed`
- `created_by`
- `created_at`
- `context_summary`: current shared summary

### Membership

The relationship between a session and room.

- `room_id`
- `session_id`
- `state`: `invited`, `active`, `declined`, `left`, or `removed`
- `role`: descriptive role chosen by the participants
- `joined_at`
- `last_read_sequence`

### Event

The ordered, immutable unit carried by the bus.

- `id`: server-generated UUID
- `room_id`
- `sequence`: monotonically increasing within a room
- `sender_id`
- `type`
- `payload`
- `reply_to_event_id`: optional
- `task_id`: optional
- `created_at`

Initial event types are `message`, `question`, `decision`, `task_created`,
`task_updated`, `artifact_published`, `conflict_reported`, `member_invited`,
`member_joined`, `member_left`, and `room_closed`.

### Task

A shared unit of work with one current owner.

- `id`
- `room_id`
- `title`
- `description`
- `status`: `open`, `claimed`, `blocked`, `completed`, or `cancelled`
- `owner_session_id`: optional
- `result_summary`: optional
- timestamps

### Artifact

A result made available to the room. The first version stores metadata and a
reference rather than copying arbitrary files into the database.

- `id`
- `room_id`
- `publisher_session_id`
- `kind`: `file`, `patch`, `commit`, `url`, or `text`
- `uri`
- `summary`
- optional content hash

## 6. Context model

A harness session retains its private internal transcript and model state. The
shared room context consists only of information explicitly published to the
bus: the objective, summary, decisions, tasks, artifacts, and event history.

When a session joins, `get_room_context` returns a compact context packet:

- room objective and current summary;
- active participants and their advertised focus;
- accepted decisions;
- open and recently completed tasks;
- published artifacts;
- recent events and an event cursor.

The complete event history remains queryable. The hub does not attempt to
translate or clone hidden context between harnesses.

## 7. MCP tool surface

The initial MCP server provides:

- `register_session`
- `heartbeat`
- `update_session`
- `list_sessions`
- `create_room`
- `invite_sessions`
- `list_invitations`
- `respond_to_invitation`
- `list_rooms`
- `get_room_context`
- `send_message`
- `list_events`
- `wait_for_events`
- `create_task`
- `claim_task`
- `update_task`
- `publish_artifact`
- `leave_room`
- `close_room`

All mutating calls accept an idempotency key. Calls are authenticated with the
session's instance token, and the server derives the sender identity from that
token instead of trusting a caller-supplied sender ID.

## 8. Delivery and presence

Events are persisted before delivery. Each room event receives an ordered
sequence number. Consumers request events after their last acknowledged cursor,
making delivery at least once. Clients must tolerate duplicate delivery by event
ID.

`wait_for_events` blocks until an applicable event arrives or a configurable
timeout expires. Harness adapters may instead subscribe through WebSocket and
inject or surface new activity through runtime-specific mechanisms.

Presence is advisory. A session is `offline` after its heartbeat lease expires;
this does not delete its identity, memberships, tasks, or unread events.

## 9. Collaboration lifecycle

1. Each open harness session registers and starts maintaining presence.
2. A session discovers peers and creates a room with an objective.
3. It invites one or more sessions.
4. Invitees inspect the room preview and accept or decline.
5. Accepted sessions receive the room context packet.
6. Participants exchange messages, decisions, tasks, and artifacts.
7. A participant can add another session at any time.
8. Participants complete their tasks and publish results.
9. A participant closes the room with a final summary when collaboration ends.

The protocol does not require a permanent leader after room creation.

## 10. Human interface

The first web interface contains:

1. **Sessions:** online status, harness, project, capabilities, and current focus.
2. **Rooms:** objective, status, participants, unread activity, and task progress.
3. **Room detail:** chronological event stream, threads, participants, shared
   context, task board, decisions, and artifacts.

The interface updates over WebSocket. A human may post a message, answer a
question, or close a room. Human actions are recorded as normal events with a
distinct human actor identity.

## 11. Failure handling

- Database transactions atomically persist events and related state changes.
- Idempotency keys prevent retries from duplicating mutations.
- Event cursors allow reconnecting consumers to resume without data loss.
- Expired presence never discards messages or task ownership.
- An invitation to an offline session remains pending.
- Unknown or unsupported event payload versions are preserved and ignored by
  consumers that cannot interpret them.
- Closing a room rejects new mutations while preserving read access.

## 12. Security boundary

The first version listens only on loopback. Session registration returns a
random instance token stored by the local adapter. The server validates room
membership for reads and writes and never accepts a sender identity directly
from tool arguments.

Project paths and artifact references are data, not authorization to read a
file. The hub does not read arbitrary project files on behalf of another
session.

## 13. Implementation boundaries

The implementation should keep these modules independent:

- **domain:** entities, transitions, and authorization rules;
- **event store:** SQLite persistence and ordered event queries;
- **application service:** collaboration use cases and transactions;
- **MCP adapter:** tool schemas and protocol translation;
- **HTTP/WebSocket adapter:** UI API and subscriptions;
- **harness adapters:** runtime-specific event delivery;
- **web application:** human observability and intervention.

The domain layer must not depend on MCP, HTTP, a particular harness, or the web
framework.

## 14. Testing strategy

- Domain tests cover invitation, membership, room, task, and closure rules.
- Persistence tests verify transactionality, sequence ordering, cursors, and
  idempotency against a real temporary SQLite database.
- MCP contract tests exercise every tool through an in-process MCP client.
- WebSocket tests verify subscription, reconnect, and missed-event recovery.
- Adapter contract tests run the same behavior suite for each harness adapter.
- One end-to-end scenario starts two simulated sessions, creates a room, accepts
  an invitation, exchanges messages, completes a task, and closes the room.

## 15. MVP completion criteria

The MVP is complete when two simulated sessions and at least two real sessions
from different supported harnesses can:

1. Register and see one another.
2. Create and join a room without human message relaying.
3. Exchange durable messages and recover after reconnecting.
4. Coordinate and complete a shared task.
5. Display the complete collaboration live in the web interface.
6. Add a third session to an active room and provide enough shared context for
   it to participate.

## 16. Deferred decisions

The implementation plan must select a language and frameworks for the daemon,
MCP server, and web application. File/worktree reservations, automatic context
summarization, remote networking, and autonomous harness process control remain
future extensions.
