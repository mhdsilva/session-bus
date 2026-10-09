import type {
  Artifact,
  Membership,
  Room,
  RoomEvent,
  Session,
  SessionProfile,
  SharedTask,
} from "@session-bus/protocol";
import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.js";
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
import {
  authenticateSession,
  expirePresence,
  heartbeat,
  registerSession,
} from "./sessions.js";

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

  async listByRoom(roomId: string): Promise<RoomEvent[]> {
    return this.events.filter((e) => e.roomId === roomId);
  }
}

class MemoryTaskRepository implements TaskRepository {
  private readonly tasks: SharedTask[] = [];

  async insert(task: SharedTask): Promise<void> {
    this.tasks.push(task);
  }

  async listByRoom(roomId: string): Promise<SharedTask[]> {
    return this.tasks.filter((t) => t.roomId === roomId);
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
    heartbeat: (auth: string, status?: Session["status"]) =>
      heartbeat(deps, auth, status),
    expirePresence: (timeoutMs?: number) => expirePresence(deps, timeoutMs),
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

async function fixture(): Promise<{
  service: Service;
  alice: KnownSession;
  bob: KnownSession;
  mallory: KnownSession;
}> {
  const service = createService();
  const alice = await registerAs(service, "alice");
  const bob = await registerAs(service, "bob");
  const mallory = await registerAs(service, "mallory");
  return { service, alice, bob, mallory };
}

async function createRoomAndInvite(
  service: Service,
  alice: KnownSession,
  bob: KnownSession,
): Promise<Room> {
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
  return room;
}

describe("room membership authorization", () => {
  it("allows only an active room member to invite another session", async () => {
    const { service, alice, bob, mallory } = await fixture();
    const room = await service.createRoom(alice.auth, {
      title: "Ship auth",
      objective: "Implement and review authentication",
      idempotencyKey: "create-room-1",
    });
    await expect(
      service.inviteSessions(mallory.auth, {
        roomId: room.id,
        sessionIds: [bob.session.id],
        idempotencyKey: "invite-1",
      }),
    ).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_REQUIRED" });
  });

  it("does not expose full room context before an invitation is accepted", async () => {
    const { service, alice, bob } = await fixture();
    const room = await createRoomAndInvite(service, alice, bob);
    await expect(
      service.getRoomContext(bob.auth, room.id),
    ).rejects.toMatchObject({
      code: "INVITATION_NOT_ACCEPTED",
    });
  });

  it("makes the room creator an active member atomically", async () => {
    const { service, alice } = await fixture();
    const room = await service.createRoom(alice.auth, {
      title: "Ship auth",
      objective: "Implement and review authentication",
      idempotencyKey: "create-room-1",
    });
    const context = await service.getRoomContext(alice.auth, room.id);
    expect(context.memberships).toContainEqual(
      expect.objectContaining({
        roomId: room.id,
        sessionId: alice.session.id,
        state: "active",
      }),
    );
  });

  it("rejects a response from a session that was never invited", async () => {
    const { service, alice, bob, mallory } = await fixture();
    const room = await createRoomAndInvite(service, alice, bob);
    await expect(
      service.respondToInvitation(mallory.auth, {
        roomId: room.id,
        accept: true,
      }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_ACCEPTED" });
  });

  it("exposes full room context after the invitation is accepted", async () => {
    const { service, alice, bob } = await fixture();
    const room = await createRoomAndInvite(service, alice, bob);
    await service.respondToInvitation(bob.auth, {
      roomId: room.id,
      accept: true,
    });
    const context = await service.getRoomContext(bob.auth, room.id);
    expect(context.room.id).toBe(room.id);
    expect(context.participants.map((p) => p.id).sort()).toEqual(
      [alice.session.id, bob.session.id].sort(),
    );
  });
});

describe("invitation transitions", () => {
  it("rejects a second response to the same invitation", async () => {
    const { service, alice, bob } = await fixture();
    const room = await createRoomAndInvite(service, alice, bob);
    await service.respondToInvitation(bob.auth, {
      roomId: room.id,
      accept: true,
    });
    await expect(
      service.respondToInvitation(bob.auth, { roomId: room.id, accept: false }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("records a decline and forbids later acceptance", async () => {
    const { service, alice, bob } = await fixture();
    const room = await createRoomAndInvite(service, alice, bob);
    const declined = await service.respondToInvitation(bob.auth, {
      roomId: room.id,
      accept: false,
    });
    expect(declined.state).toBe("declined");
    await expect(
      service.respondToInvitation(bob.auth, { roomId: room.id, accept: true }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(
      service.getRoomContext(bob.auth, room.id),
    ).rejects.toMatchObject({
      code: "INVITATION_NOT_ACCEPTED",
    });
  });
});

describe("presence expiry", () => {
  it("marks sessions with expired heartbeats offline without removing memberships", async () => {
    const { service, alice, bob } = await fixture();
    const room = await createRoomAndInvite(service, alice, bob);
    await service.respondToInvitation(bob.auth, {
      roomId: room.id,
      accept: true,
    });

    service.clock.advance(10 * 60 * 1000);
    const expired = await service.expirePresence(5 * 60 * 1000);
    expect(expired.map((s) => s.id)).toContain(bob.session.id);

    const context = await service.getRoomContext(alice.auth, room.id);
    expect(context.memberships).toContainEqual(
      expect.objectContaining({ sessionId: bob.session.id, state: "active" }),
    );
    expect(context.participants).toContainEqual(
      expect.objectContaining({ id: bob.session.id, status: "offline" }),
    );
  });

  it("keeps recently seen sessions available", async () => {
    const { service, alice, bob } = await fixture();
    await createRoomAndInvite(service, alice, bob);
    service.clock.advance(60 * 1000);
    await service.heartbeat(bob.auth);
    service.clock.advance(60 * 1000);
    const expired = await service.expirePresence(5 * 60 * 1000);
    expect(expired.map((s) => s.id)).not.toContain(bob.session.id);
  });
});

describe("session identity", () => {
  it("authenticates with the issued token and rejects unknown tokens", async () => {
    const { service, alice } = await fixture();
    const me = await authenticateSession(service.deps.db, alice.auth);
    expect(me.id).toBe(alice.session.id);
    await expect(
      authenticateSession(service.deps.db, "bogus-token"),
    ).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });
});

describe("idempotency", () => {
  it("returns the same room for a repeated create with the same key", async () => {
    const { service, alice } = await fixture();
    const input = {
      title: "Ship auth",
      objective: "Implement and review authentication",
      idempotencyKey: "create-room-1",
    };
    const first = await service.createRoom(alice.auth, input);
    const second = await service.createRoom(alice.auth, input);
    expect(second.id).toBe(first.id);
  });

  it("rejects idempotency key reuse with different parameters", async () => {
    const { service, alice } = await fixture();
    await service.createRoom(alice.auth, {
      title: "Ship auth",
      objective: "Implement and review authentication",
      idempotencyKey: "create-room-1",
    });
    await expect(
      service.createRoom(alice.auth, {
        title: "Something else",
        objective: "Implement and review authentication",
        idempotencyKey: "create-room-1",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
