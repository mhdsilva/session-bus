import type {
  Artifact,
  Membership,
  Room,
  RoomEvent,
  Session,
  SharedTask,
} from "@session-bus/protocol";

/**
 * Repository and transaction ports. Methods accept already validated
 * domain values; implementations live outside the domain (SQLite,
 * in-memory fakes in tests). The domain stays independent from
 * SQLite, HTTP, MCP, Fastify, and React.
 */

/** A session as stored: the protocol Session plus the token hash. */
export interface StoredSession extends Session {
  tokenHash: string;
}

export interface SessionRepository {
  insert(session: StoredSession): Promise<void>;
  findById(id: string): Promise<StoredSession | null>;
  findByTokenHash(tokenHash: string): Promise<StoredSession | null>;
  update(session: StoredSession): Promise<void>;
  listAll(): Promise<StoredSession[]>;
}

export interface RoomRepository {
  insert(room: Room): Promise<void>;
  findById(id: string): Promise<Room | null>;
  listRooms(): Promise<Room[]>;
  update(room: Room): Promise<void>;
  saveMembership(membership: Membership): Promise<void>;
  findMembership(roomId: string, sessionId: string): Promise<Membership | null>;
  listMemberships(roomId: string): Promise<Membership[]>;
  listMembershipsForSession(sessionId: string): Promise<Membership[]>;
}

export interface EventRepository {
  insert(event: RoomEvent): Promise<void>;
  /**
   * Allocate the next per-room sequence (current maximum + 1). Adapters
   * must read this inside the same write transaction that inserts the
   * event so concurrent writers cannot reuse a sequence.
   */
  nextSequence(roomId: string): Promise<number>;
  listByRoom(roomId: string): Promise<RoomEvent[]>;
  /** Events with `sequence > afterSequence`, ascending, optionally capped. */
  listAfter(
    roomId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<RoomEvent[]>;
}

export interface TaskRepository {
  insert(task: SharedTask): Promise<void>;
  findById(id: string): Promise<SharedTask | null>;
  update(task: SharedTask): Promise<void>;
  listByRoom(roomId: string): Promise<SharedTask[]>;
}

export interface ArtifactRepository {
  insert(artifact: Artifact): Promise<void>;
  listByRoom(roomId: string): Promise<Artifact[]>;
}

export interface IdempotencyRepository {
  find(key: string): Promise<unknown | null>;
  save(key: string, value: unknown): Promise<void>;
}

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
