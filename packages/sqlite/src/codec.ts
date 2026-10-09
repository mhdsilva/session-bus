import type { StoredSession } from "@session-bus/domain";
import {
  type Artifact,
  artifactSchema,
  type Membership,
  membershipSchema,
  type Room,
  type RoomEvent,
  roomEventSchema,
  roomSchema,
  type SharedTask,
  sessionSchema,
  sharedTaskSchema,
} from "@session-bus/protocol";

export class PersistenceError extends Error {
  override readonly name = "PersistenceError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function decodeJson<T>(
  json: string,
  label: string,
  parse: (value: unknown) => T,
): T {
  try {
    return parse(JSON.parse(json));
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError(`Stored ${label} is malformed or invalid`, {
      cause: error,
    });
  }
}

export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) {
    throw new TypeError("Stored JSON value must be serializable");
  }
  return serialized;
}

function fromRow<T>(
  row: unknown,
  label: string,
  parse: (value: unknown) => T,
): T {
  try {
    return parse(row);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError(`Stored ${label} is malformed or invalid`, {
      cause: error,
    });
  }
}

export const decodeSession = (row: unknown): StoredSession =>
  fromRow(row, "session", (value) => {
    const r = value as Record<string, unknown>;
    if (typeof r.token_hash !== "string") {
      throw new TypeError("Stored token hash is not a string");
    }
    return {
      ...sessionSchema.parse({
        id: r.id,
        name: r.name,
        harness: { name: r.harness_name, version: r.harness_version },
        projectRoot: r.project_root,
        capabilities: JSON.parse(String(r.capabilities_json)),
        currentFocus: r.current_focus,
        metadata: JSON.parse(String(r.metadata_json)),
        status: r.status,
        lastSeenAt: r.last_seen_at,
      }),
      tokenHash: r.token_hash,
    };
  });

export const decodeRoom = (row: unknown): Room =>
  fromRow(row, "room", (v) => {
    const r = v as Record<string, unknown>;
    return roomSchema.parse({
      id: r.id,
      title: r.title,
      objective: r.objective,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      contextSummary: r.context_summary,
    });
  });
export const decodeMembership = (row: unknown): Membership =>
  fromRow(row, "membership", (v) => {
    const r = v as Record<string, unknown>;
    return membershipSchema.parse({
      roomId: r.room_id,
      sessionId: r.session_id,
      state: r.state,
      role: r.role,
      joinedAt: r.joined_at,
      lastReadSequence: r.last_read_sequence,
    });
  });
export const decodeEvent = (row: unknown): RoomEvent =>
  fromRow(row, "event", (v) => {
    const r = v as Record<string, unknown>;
    const payload = JSON.parse(String(r.payload_json));
    return roomEventSchema.parse({
      id: r.id,
      roomId: r.room_id,
      sequence: r.sequence,
      senderId: r.sender_id,
      type: r.type,
      version: r.version,
      payload,
      ...(r.reply_to_event_id ? { replyToEventId: r.reply_to_event_id } : {}),
      ...(r.task_id ? { taskId: r.task_id } : {}),
      createdAt: r.created_at,
    });
  });
export const decodeTask = (row: unknown): SharedTask =>
  fromRow(row, "task", (v) => {
    const r = v as Record<string, unknown>;
    return sharedTaskSchema.parse({
      id: r.id,
      roomId: r.room_id,
      title: r.title,
      description: r.description,
      status: r.status,
      ...(r.owner_session_id ? { ownerSessionId: r.owner_session_id } : {}),
      ...(r.result_summary !== null ? { resultSummary: r.result_summary } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  });
export const decodeArtifact = (row: unknown): Artifact =>
  fromRow(row, "artifact", (v) => {
    const r = v as Record<string, unknown>;
    return artifactSchema.parse({
      id: r.id,
      roomId: r.room_id,
      publisherSessionId: r.publisher_session_id,
      kind: r.kind,
      uri: r.uri,
      summary: r.summary,
      ...(r.content_hash !== null ? { contentHash: r.content_hash } : {}),
      createdAt: r.created_at,
    });
  });

export const sessionValues = (s: StoredSession) => [
  s.id,
  s.name,
  s.harness.name,
  s.harness.version,
  s.projectRoot,
  canonicalJson(s.capabilities),
  s.currentFocus,
  canonicalJson(s.metadata),
  s.status,
  s.lastSeenAt,
  s.tokenHash,
];
export const roomValues = (r: Room) => [
  r.id,
  r.title,
  r.objective,
  r.status,
  r.createdBy,
  r.createdAt,
  r.contextSummary,
];
export const membershipValues = (m: Membership) => [
  m.roomId,
  m.sessionId,
  m.state,
  m.role,
  m.joinedAt,
  m.lastReadSequence,
];
export const eventValues = (e: RoomEvent) => [
  e.id,
  e.roomId,
  e.sequence,
  e.senderId,
  e.type,
  e.version,
  canonicalJson(e.payload),
  e.replyToEventId ?? null,
  e.taskId ?? null,
  e.createdAt,
];
export const taskValues = (t: SharedTask) => [
  t.id,
  t.roomId,
  t.title,
  t.description,
  t.status,
  t.ownerSessionId ?? null,
  t.resultSummary ?? null,
  t.createdAt,
  t.updatedAt,
];
export const artifactValues = (a: Artifact) => [
  a.id,
  a.roomId,
  a.publisherSessionId,
  a.kind,
  a.uri,
  a.summary,
  a.contentHash ?? null,
  a.createdAt,
];
