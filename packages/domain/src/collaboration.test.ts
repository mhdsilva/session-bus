import type {
  Artifact,
  ArtifactKind,
  Membership,
  Room,
  RoomEvent,
  Session,
  SessionProfile,
  SharedTask,
} from "@session-bus/protocol";
import { describe, expect, it } from "vitest";
import { publishArtifact } from "./artifacts.js";
import type { Clock } from "./clock.js";
import { closeRoom, leaveRoom, listEvents, sendMessage } from "./events.js";
import type { IdGenerator } from "./ids.js";
import type {
  ArtifactRepository,
  Database,
  EventRepository,
  IdempotencyRepository,
  RoomRepository,
  SessionRepository,
  StoredSession,
  TaskRepository,
  UnitOfWork,
} from "./repositories.js";
import {
  createRoom,
  getRoomContext,
  inviteSessions,
  respondToInvitation,
} from "./rooms.js";
import { registerSession } from "./sessions.js";
import {
  claimTask,
  createTask,
  type UpdateTaskStatus,
  updateTask,
} from "./tasks.js";

/** Deterministic UUIDs so protocol schema validation accepts generated ids. */
function deterministicUuid(n: number): string {
  return `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`;
}

class TestClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class TestIds implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return deterministicUuid(this.counter);
  }
}

class MemorySessionRepository implements SessionRepository {
  private readonly byId = new Map<string, StoredSession>();
  private readonly byTokenHash = new Map<string, StoredSession>();

  async insert(session: StoredSession): Promise<void> {
    this.byId.set(session.id, session);
    this.byTokenHash.set(session.tokenHash, session);
  }

  async findById(id: string): Promise<StoredSession | null> {
    return this.byId.get(id) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
    return this.byTokenHash.get(tokenHash) ?? null;
  }

  async update(session: StoredSession): Promise<void> {
    this.byId.set(session.id, session);
    this.byTokenHash.set(session.tokenHash, session);
  }

  async listAll(): Promise<StoredSession[]> {
    return [...this.byId.values()];
  }
}

class MemoryRoomRepository implements RoomRepository {
  private readonly rooms = new Map<string, Room>();
  private readonly memberships = new Map<string, Membership>();

  async insert(room: Room): Promise<void> {
    this.rooms.set(room.id, room);
  }

  async findById(id: string): Promise<Room | null> {
    return this.rooms.get(id) ?? null;
  }

  async update(room: Room): Promise<void> {
    this.rooms.set(room.id, room);
  }

  async saveMembership(membership: Membership): Promise<void> {
    this.memberships.set(
      `${membership.roomId}:${membership.sessionId}`,
      membership,
    );
  }

  async findMembership(
    roomId: string,
    sessionId: string,
  ): Promise<Membership | null> {
    return this.memberships.get(`${roomId}:${sessionId}`) ?? null;
  }

  async listMemberships(roomId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((m) => m.roomId === roomId);
  }
}

class MemoryEventRepository implements EventRepository {
  private readonly events: RoomEvent[] = [];

  async insert(event: RoomEvent): Promise<void> {
    this.events.push(event);
  }

  async nextSequence(roomId: string): Promise<number> {
    return (
      this.events
        .filter((e) => e.roomId === roomId)
        .reduce((max, e) => Math.max(max, e.sequence), 0) + 1
    );
  }

  async listByRoom(roomId: string): Promise<RoomEvent[]> {
    return this.events.filter((e) => e.roomId === roomId);
  }

  async listAfter(
    roomId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<RoomEvent[]> {
    const matching = this.events
      .filter((e) => e.roomId === roomId && e.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
    return limit === undefined ? matching : matching.slice(0, limit);
  }
}

class MemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, SharedTask>();

  async insert(task: SharedTask): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async findById(id: string): Promise<SharedTask | null> {
    return this.tasks.get(id) ?? null;
  }

  async update(task: SharedTask): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async listByRoom(roomId: string): Promise<SharedTask[]> {
    return [...this.tasks.values()].filter((t) => t.roomId === roomId);
  }
}

class MemoryArtifactRepository implements ArtifactRepository {
  private readonly artifacts: Artifact[] = [];

  async insert(artifact: Artifact): Promise<void> {
    this.artifacts.push(artifact);
  }

  async listByRoom(roomId: string): Promise<Artifact[]> {
    return this.artifacts.filter((a) => a.roomId === roomId);
  }
}

class MemoryIdempotencyRepository implements IdempotencyRepository {
  private readonly entries = new Map<string, unknown>();

  async find(key: string): Promise<unknown | null> {
    return this.entries.get(key) ?? null;
  }

  async save(key: string, value: unknown): Promise<void> {
    this.entries.set(key, value);
  }
}

function createUnitOfWork(): UnitOfWork {
  return {
    sessions: new MemorySessionRepository(),
    rooms: new MemoryRoomRepository(),
    events: new MemoryEventRepository(),
    tasks: new MemoryTaskRepository(),
    artifacts: new MemoryArtifactRepository(),
    idempotency: new MemoryIdempotencyRepository(),
  };
}

class MemoryDatabase implements Database {
  constructor(readonly uow: UnitOfWork) {}

  async read<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return work(this.uow);
  }

  async write<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return work(this.uow);
  }
}

function createService() {
  const clock = new TestClock(new Date("2026-10-08T12:00:00.000Z"));
  const ids = new TestIds();
  const db = new MemoryDatabase(createUnitOfWork());
  const deps = { db, clock, ids };
  return {
    deps,
    clock,
    register: (profile: SessionProfile) => registerSession(deps, profile),
    createRoom: (
      auth: string,
      input: { title: string; objective: string; idempotencyKey: string },
    ) => createRoom(deps, auth, input),
    inviteSessions: (
      auth: string,
      input: { roomId: string; sessionIds: string[]; idempotencyKey: string },
    ) => inviteSessions(deps, auth, input),
    respondToInvitation: (
      auth: string,
      input: { roomId: string; accept: boolean },
    ) => respondToInvitation(deps, auth, input),
    getRoomContext: (auth: string, roomId: string) =>
      getRoomContext(deps, auth, roomId),
    sendMessage: (
      auth: string,
      input: {
        roomId: string;
        text: string;
        type?: "message" | "question" | "decision" | "conflict_reported";
        replyToEventId?: string;
        taskId?: string;
        idempotencyKey: string;
      },
    ) => sendMessage(deps, auth, input),
    listEvents: (
      auth: string,
      roomId: string,
      afterSequence?: number,
      limit?: number,
    ) => listEvents(deps, auth, roomId, afterSequence, limit),
    createTask: (
      auth: string,
      input: {
        roomId: string;
        title: string;
        description?: string;
        idempotencyKey: string;
      },
    ) => createTask(deps, auth, input),
    claimTask: (
      auth: string,
      input: { taskId: string; idempotencyKey: string },
    ) => claimTask(deps, auth, input),
    updateTask: (
      auth: string,
      input: {
        taskId: string;
        status: UpdateTaskStatus;
        resultSummary?: string;
        idempotencyKey: string;
      },
    ) => updateTask(deps, auth, input),
    publishArtifact: (
      auth: string,
      input: {
        roomId: string;
        kind: string;
        uri: string;
        summary?: string;
        contentHash?: string;
        idempotencyKey: string;
      },
    ) => publishArtifact(deps, auth, input),
    leaveRoom: (
      auth: string,
      input: { roomId: string; idempotencyKey: string },
    ) => leaveRoom(deps, auth, input),
    closeRoom: (
      auth: string,
      input: { roomId: string; summary: string; idempotencyKey: string },
    ) => closeRoom(deps, auth, input),
  };
}

type Service = ReturnType<typeof createService>;

interface KnownSession {
  session: Session;
  auth: string;
}

function profileFor(name: string): SessionProfile {
  return {
    name,
    harness: { name: "test-harness", version: "0.0.0" },
    projectRoot: "/tmp/session-bus-test",
    capabilities: [],
    currentFocus: "",
    metadata: {},
  };
}

async function registerAs(
  service: Service,
  name: string,
): Promise<KnownSession> {
  const { session, token } = await service.register(profileFor(name));
  return { session, auth: token };
}

interface ActiveRoomFixture {
  service: Service;
  room: Room;
  alice: KnownSession;
  bob: KnownSession;
  mallory: KnownSession;
}

/** Alice creates a room, invites Bob, and Bob accepts; Mallory stays a stranger. */
async function activeRoomFixture(): Promise<ActiveRoomFixture> {
  const service = createService();
  const alice = await registerAs(service, "alice");
  const bob = await registerAs(service, "bob");
  const mallory = await registerAs(service, "mallory");
  const room = await service.createRoom(alice.auth, {
    title: "Ship auth",
    objective: "Implement and review authentication",
    idempotencyKey: "create-room-1",
  });
  await service.inviteSessions(alice.auth, {
    roomId: room.id,
    sessionIds: [bob.session.id],
    idempotencyKey: "invite-1",
  });
  await service.respondToInvitation(bob.auth, {
    roomId: room.id,
    accept: true,
  });
  return { service, room, alice, bob, mallory };
}

describe("collaboration authorization", () => {
  it("rejects a stranger from sending a message", async () => {
    const { service, room, mallory } = await activeRoomFixture();
    await expect(
      service.sendMessage(mallory.auth, {
        roomId: room.id,
        text: "I was not invited",
        idempotencyKey: "m-1",
      }),
    ).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_REQUIRED" });
  });

  it("rejects a stranger from listing events", async () => {
    const { service, room, mallory } = await activeRoomFixture();
    await expect(
      service.listEvents(mallory.auth, room.id, 0, 50),
    ).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_REQUIRED" });
  });

  it("rejects an invited-but-inactive member from reading events", async () => {
    const service = createService();
    const alice = await registerAs(service, "alice");
    const bob = await registerAs(service, "bob");
    const room = await service.createRoom(alice.auth, {
      title: "Ship auth",
      objective: "Implement and review authentication",
      idempotencyKey: "create-room-1",
    });
    await service.inviteSessions(alice.auth, {
      roomId: room.id,
      sessionIds: [bob.session.id],
      idempotencyKey: "invite-1",
    });
    await expect(
      service.listEvents(bob.auth, room.id, 0, 50),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_ACCEPTED" });
  });

  it("rejects an invited-but-inactive member from sending a message", async () => {
    const service = createService();
    const alice = await registerAs(service, "alice");
    const bob = await registerAs(service, "bob");
    const room = await service.createRoom(alice.auth, {
      title: "Ship auth",
      objective: "Implement and review authentication",
      idempotencyKey: "create-room-1",
    });
    await service.inviteSessions(alice.auth, {
      roomId: room.id,
      sessionIds: [bob.session.id],
      idempotencyKey: "invite-1",
    });
    await expect(
      service.sendMessage(bob.auth, {
        roomId: room.id,
        text: "not accepted yet",
        idempotencyKey: "m-1",
      }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_ACCEPTED" });
  });
});

describe("room event log", () => {
  it("appends messages with strictly increasing per-room sequences", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    await service.sendMessage(alice.auth, {
      roomId: room.id,
      text: "one",
      idempotencyKey: "m-1",
    });
    await service.sendMessage(alice.auth, {
      roomId: room.id,
      text: "two",
      idempotencyKey: "m-2",
    });
    await service.sendMessage(bob.auth, {
      roomId: room.id,
      text: "three",
      idempotencyKey: "m-3",
    });
    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual([
      "message",
      "message",
      "message",
    ]);
  });

  it("lists only events after the cursor, in order and within the limit", async () => {
    const { service, room, alice } = await activeRoomFixture();
    for (const index of [1, 2, 3, 4]) {
      await service.sendMessage(alice.auth, {
        roomId: room.id,
        text: `message-${index}`,
        idempotencyKey: `m-${index}`,
      });
    }
    const page = await service.listEvents(alice.auth, room.id, 1, 2);
    expect(page.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("records question, decision, and conflict events with their declared type", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    await service.sendMessage(alice.auth, {
      roomId: room.id,
      text: "Is this the right schema?",
      type: "question",
      idempotencyKey: "q-1",
    });
    await service.sendMessage(bob.auth, {
      roomId: room.id,
      text: "We will use camelCase",
      type: "decision",
      idempotencyKey: "d-1",
    });
    await service.sendMessage(bob.auth, {
      roomId: room.id,
      text: "Two writers touched the same migration",
      type: "conflict_reported",
      idempotencyKey: "c-1",
    });
    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    expect(events.map((event) => event.type)).toEqual([
      "question",
      "decision",
      "conflict_reported",
    ]);
  });
});

describe("idempotency", () => {
  it("returns the original event for a repeated message without duplicating it", async () => {
    const { service, room, alice } = await activeRoomFixture();
    const input = {
      roomId: room.id,
      text: "ship it",
      idempotencyKey: "m-1",
    };
    const first = await service.sendMessage(alice.auth, input);
    const second = await service.sendMessage(alice.auth, input);
    expect(second).toEqual(first);
    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    expect(events.filter((event) => event.type === "message")).toHaveLength(1);
  });

  it("rejects a repeated message key with different parameters", async () => {
    const { service, room, alice } = await activeRoomFixture();
    await service.sendMessage(alice.auth, {
      roomId: room.id,
      text: "ship it",
      idempotencyKey: "m-1",
    });
    await expect(
      service.sendMessage(alice.auth, {
        roomId: room.id,
        text: "something else",
        idempotencyKey: "m-1",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("task lifecycle", () => {
  it("permits only one session to claim an open task", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    const task = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Review schema",
      description: "Check migrations",
      idempotencyKey: "task-1",
    });
    const claimed = await service.claimTask(bob.auth, {
      taskId: task.id,
      idempotencyKey: "claim-1",
    });
    expect(claimed.status).toBe("claimed");
    expect(claimed.ownerSessionId).toBe(bob.session.id);
    await expect(
      service.claimTask(alice.auth, {
        taskId: task.id,
        idempotencyKey: "claim-2",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("returns the original task for a retried claim key", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    const task = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Review schema",
      idempotencyKey: "task-1",
    });
    const first = await service.claimTask(bob.auth, {
      taskId: task.id,
      idempotencyKey: "claim-1",
    });
    const second = await service.claimTask(bob.auth, {
      taskId: task.id,
      idempotencyKey: "claim-1",
    });
    expect(second).toEqual(first);
    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    expect(
      events.filter((event) => event.type === "task_updated"),
    ).toHaveLength(1);
  });

  it("lets any active member cancel an open task", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    const task = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Review schema",
      idempotencyKey: "task-1",
    });
    const cancelled = await service.updateTask(bob.auth, {
      taskId: task.id,
      status: "cancelled",
      idempotencyKey: "cancel-1",
    });
    expect(cancelled.status).toBe("cancelled");
  });

  it("lets only the owner block and complete a claimed task", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    const task = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Review schema",
      idempotencyKey: "task-1",
    });
    await service.claimTask(bob.auth, {
      taskId: task.id,
      idempotencyKey: "claim-1",
    });
    await expect(
      service.updateTask(alice.auth, {
        taskId: task.id,
        status: "completed",
        idempotencyKey: "complete-wrong",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const completed = await service.updateTask(bob.auth, {
      taskId: task.id,
      status: "completed",
      resultSummary: "Schema approved",
      idempotencyKey: "complete-1",
    });
    expect(completed.status).toBe("completed");
    expect(completed.resultSummary).toBe("Schema approved");
  });

  it("supports blocked -> claimed -> completed with a new owner", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    const task = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Review schema",
      idempotencyKey: "task-1",
    });
    await service.claimTask(bob.auth, {
      taskId: task.id,
      idempotencyKey: "claim-1",
    });
    const blocked = await service.updateTask(bob.auth, {
      taskId: task.id,
      status: "blocked",
      idempotencyKey: "block-1",
    });
    expect(blocked.status).toBe("blocked");
    const reclaimed = await service.claimTask(alice.auth, {
      taskId: task.id,
      idempotencyKey: "claim-2",
    });
    expect(reclaimed.status).toBe("claimed");
    expect(reclaimed.ownerSessionId).toBe(alice.session.id);
    const completed = await service.updateTask(alice.auth, {
      taskId: task.id,
      status: "completed",
      idempotencyKey: "complete-1",
    });
    expect(completed.status).toBe("completed");
  });

  it("treats completed and cancelled tasks as terminal", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    const first = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Review schema",
      idempotencyKey: "task-1",
    });
    await service.claimTask(bob.auth, {
      taskId: first.id,
      idempotencyKey: "claim-1",
    });
    await service.updateTask(bob.auth, {
      taskId: first.id,
      status: "completed",
      idempotencyKey: "complete-1",
    });
    await expect(
      service.updateTask(bob.auth, {
        taskId: first.id,
        status: "blocked",
        idempotencyKey: "block-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(
      service.claimTask(alice.auth, {
        taskId: first.id,
        idempotencyKey: "claim-2",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const second = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Another task",
      idempotencyKey: "task-2",
    });
    await service.updateTask(alice.auth, {
      taskId: second.id,
      status: "cancelled",
      idempotencyKey: "cancel-1",
    });
    await expect(
      service.claimTask(bob.auth, {
        taskId: second.id,
        idempotencyKey: "claim-3",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("rejects transitions for an unknown task", async () => {
    const { service, bob } = await activeRoomFixture();
    await expect(
      service.claimTask(bob.auth, {
        taskId: deterministicUuid(900),
        idempotencyKey: "claim-missing",
      }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("lets any active member report a conflict through the event log", async () => {
    const { service, room, bob } = await activeRoomFixture();
    const event = await service.sendMessage(bob.auth, {
      roomId: room.id,
      text: "Concurrent edit detected",
      type: "conflict_reported",
      idempotencyKey: "conflict-1",
    });
    expect(event.type).toBe("conflict_reported");
  });
});

describe("artifacts", () => {
  it("rejects unknown kinds and malformed URIs", async () => {
    const { service, room, alice } = await activeRoomFixture();
    await expect(
      service.publishArtifact(alice.auth, {
        roomId: room.id,
        kind: "binary" as unknown as ArtifactKind,
        uri: "/repo/out.bin",
        idempotencyKey: "a-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(
      service.publishArtifact(alice.auth, {
        roomId: room.id,
        kind: "file",
        uri: "relative/path.ts",
        idempotencyKey: "a-2",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(
      service.publishArtifact(alice.auth, {
        roomId: room.id,
        kind: "url",
        uri: "not a uri",
        idempotencyKey: "a-3",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("stores only the validated reference and publishes an event", async () => {
    const { service, room, alice } = await activeRoomFixture();
    const artifact = await service.publishArtifact(alice.auth, {
      roomId: room.id,
      kind: "url",
      uri: "https://example.com/pull/42",
      summary: "Review link",
      idempotencyKey: "a-1",
    });
    expect(artifact.publisherSessionId).toBe(alice.session.id);
    expect(artifact.uri).toBe("https://example.com/pull/42");
    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    expect(events.at(-1)?.type).toBe("artifact_published");
  });

  it("rejects a stranger from publishing", async () => {
    const { service, room, mallory } = await activeRoomFixture();
    await expect(
      service.publishArtifact(mallory.auth, {
        roomId: room.id,
        kind: "text",
        uri: "text:notes",
        idempotencyKey: "a-1",
      }),
    ).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_REQUIRED" });
  });
});

describe("leaving a room", () => {
  it("returns owned incomplete tasks to open before appending member_left", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    const claimed = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Claimed work",
      idempotencyKey: "task-1",
    });
    const blocked = await service.createTask(alice.auth, {
      roomId: room.id,
      title: "Blocked work",
      idempotencyKey: "task-2",
    });
    await service.claimTask(bob.auth, {
      taskId: claimed.id,
      idempotencyKey: "claim-1",
    });
    await service.claimTask(bob.auth, {
      taskId: blocked.id,
      idempotencyKey: "claim-2",
    });
    await service.updateTask(bob.auth, {
      taskId: blocked.id,
      status: "blocked",
      idempotencyKey: "block-1",
    });

    const membership = await service.leaveRoom(bob.auth, {
      roomId: room.id,
      idempotencyKey: "leave-1",
    });
    expect(membership.state).toBe("left");

    const context = await service.getRoomContext(alice.auth, room.id);
    for (const task of context.tasks) {
      expect(task.status).toBe("open");
      expect(task.ownerSessionId).toBeUndefined();
    }

    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    const types = events.map((event) => event.type);
    expect(types.at(-1)).toBe("member_left");
    const releasedTaskIds = events
      .filter(
        (event) =>
          event.type === "task_updated" &&
          (event.payload.task as { status?: string } | undefined)?.status ===
            "open",
      )
      .map((event) => event.taskId)
      .sort();
    expect(releasedTaskIds).toEqual([claimed.id, blocked.id].sort());
  });

  it("is idempotent on a repeated leave", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    const first = await service.leaveRoom(bob.auth, {
      roomId: room.id,
      idempotencyKey: "leave-1",
    });
    const second = await service.leaveRoom(bob.auth, {
      roomId: room.id,
      idempotencyKey: "leave-2",
    });
    expect(second).toEqual(first);
    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    expect(events.filter((event) => event.type === "member_left")).toHaveLength(
      1,
    );
  });

  it("blocks a departed member from reading or writing", async () => {
    const { service, room, bob } = await activeRoomFixture();
    await service.leaveRoom(bob.auth, {
      roomId: room.id,
      idempotencyKey: "leave-1",
    });
    await expect(
      service.listEvents(bob.auth, room.id, 0, 50),
    ).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_REQUIRED" });
    await expect(
      service.sendMessage(bob.auth, {
        roomId: room.id,
        text: "still here",
        idempotencyKey: "m-1",
      }),
    ).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_REQUIRED" });
  });
});

describe("room closure", () => {
  it("requires a non-empty summary", async () => {
    const { service, room, alice } = await activeRoomFixture();
    await expect(
      service.closeRoom(alice.auth, {
        roomId: room.id,
        summary: "   ",
        idempotencyKey: "close-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("closes the room, records the summary, and appends room_closed", async () => {
    const { service, room, alice } = await activeRoomFixture();
    const closed = await service.closeRoom(alice.auth, {
      roomId: room.id,
      summary: "Work complete",
      idempotencyKey: "close-1",
    });
    expect(closed.status).toBe("closed");
    expect(closed.contextSummary).toBe("Work complete");
    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    expect(events.at(-1)?.type).toBe("room_closed");
  });

  it("rejects writes after closure with ROOM_CLOSED", async () => {
    const { service, room, alice } = await activeRoomFixture();
    await service.closeRoom(alice.auth, {
      roomId: room.id,
      summary: "Work complete",
      idempotencyKey: "close-1",
    });
    await expect(
      service.sendMessage(alice.auth, {
        roomId: room.id,
        text: "late",
        idempotencyKey: "message-late",
      }),
    ).rejects.toMatchObject({ code: "ROOM_CLOSED" });
    await expect(
      service.createTask(alice.auth, {
        roomId: room.id,
        title: "Too late",
        idempotencyKey: "task-late",
      }),
    ).rejects.toMatchObject({ code: "ROOM_CLOSED" });
  });

  it("lets the first close win and rejects a later close", async () => {
    const { service, room, alice, bob } = await activeRoomFixture();
    await service.closeRoom(alice.auth, {
      roomId: room.id,
      summary: "Alice closed",
      idempotencyKey: "close-1",
    });
    await expect(
      service.closeRoom(bob.auth, {
        roomId: room.id,
        summary: "Bob closed",
        idempotencyKey: "close-2",
      }),
    ).rejects.toMatchObject({ code: "ROOM_CLOSED" });
  });

  it("replays the original close for the same idempotency key", async () => {
    const { service, room, alice } = await activeRoomFixture();
    const first = await service.closeRoom(alice.auth, {
      roomId: room.id,
      summary: "Work complete",
      idempotencyKey: "close-1",
    });
    const second = await service.closeRoom(alice.auth, {
      roomId: room.id,
      summary: "Work complete",
      idempotencyKey: "close-1",
    });
    expect(second).toEqual(first);
    const events = await service.listEvents(alice.auth, room.id, 0, 50);
    expect(events.filter((event) => event.type === "room_closed")).toHaveLength(
      1,
    );
  });
});
