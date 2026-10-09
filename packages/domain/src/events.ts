import {
  type Membership,
  membershipSchema,
  type Room,
  type RoomEvent,
  type RoomEventType,
  roomEventSchema,
  roomSchema,
} from "@session-bus/protocol";
import type { Clock } from "./clock.js";
import { DomainError } from "./errors.js";
import type { IdGenerator } from "./ids.js";
import type { Database, StoredSession, UnitOfWork } from "./repositories.js";
import { hashToken } from "./sessions.js";

/**
 * Event, message, and room lifecycle use cases. Every mutation runs
 * inside `Database.write()` so the state change and its immutable
 * event commit together, and every caller is authenticated from the
 * server-issued instance token rather than a supplied sender id.
 */

export interface CollaborationDeps {
  db: Database;
  clock: Clock;
  ids: IdGenerator;
}

export const COLLABORATION_MESSAGE_TYPES = [
  "message",
  "question",
  "decision",
  "conflict_reported",
] as const;

export type CollaborationMessageType =
  (typeof COLLABORATION_MESSAGE_TYPES)[number];

export interface SendMessageInput {
  roomId: string;
  text: string;
  type?: CollaborationMessageType;
  replyToEventId?: string;
  taskId?: string;
  idempotencyKey: string;
}

export interface LeaveRoomInput {
  roomId: string;
  idempotencyKey: string;
}

export interface CloseRoomInput {
  roomId: string;
  summary: string;
  idempotencyKey: string;
}

export interface ActiveMemberContext {
  caller: StoredSession;
  room: Room;
  membership: Membership;
}

export async function authenticateCaller(
  uow: UnitOfWork,
  token: string,
): Promise<StoredSession> {
  const found = await uow.sessions.findByTokenHash(hashToken(token));
  if (!found) {
    throw new DomainError(
      "AUTHENTICATION_FAILED",
      "invalid or unknown instance token",
    );
  }
  return found;
}

export function requireActiveMembership(
  membership: Membership | null,
  room: Room,
  options: { requireOpen?: boolean } = {},
): Membership {
  if (!membership) {
    throw new DomainError(
      "ROOM_MEMBERSHIP_REQUIRED",
      "only an active room member may collaborate",
    );
  }
  if (membership.state === "invited" || membership.state === "declined") {
    throw new DomainError(
      "INVITATION_NOT_ACCEPTED",
      "invitation must be accepted before collaborating",
    );
  }
  if (membership.state !== "active") {
    throw new DomainError(
      "ROOM_MEMBERSHIP_REQUIRED",
      "only an active room member may collaborate",
    );
  }
  if (options.requireOpen && room.status !== "open") {
    throw new DomainError("ROOM_CLOSED", `room ${room.id} is ${room.status}`);
  }
  return membership;
}

export interface AppendEventInput {
  roomId: string;
  senderId: string;
  type: RoomEventType;
  payload: Record<string, unknown>;
  replyToEventId?: string;
  taskId?: string;
}

/**
 * Allocate the next sequence and persist one immutable event. Must be
 * called inside an enclosing `Database.write()` so the sequence read
 * and insert share the write transaction.
 */
export async function appendEvent(
  deps: CollaborationDeps,
  uow: UnitOfWork,
  input: AppendEventInput,
): Promise<RoomEvent> {
  const sequence = await uow.events.nextSequence(input.roomId);
  const event = roomEventSchema.parse({
    id: deps.ids.next(),
    roomId: input.roomId,
    sequence,
    senderId: input.senderId,
    type: input.type,
    version: 1,
    payload: input.payload,
    replyToEventId: input.replyToEventId,
    taskId: input.taskId,
    createdAt: deps.clock.now().toISOString(),
  });
  await uow.events.insert(event);
  return event;
}

interface SendMessageIdempotencyRecord {
  roomId: string;
  type: CollaborationMessageType;
  text: string;
  replyToEventId?: string;
  taskId?: string;
  event: RoomEvent;
}

/** Append a message, question, decision, or conflict report to the room log. */
export async function sendMessage(
  deps: CollaborationDeps,
  authToken: string,
  input: SendMessageInput,
): Promise<RoomEvent> {
  const type: CollaborationMessageType = input.type ?? "message";
  if (!COLLABORATION_MESSAGE_TYPES.includes(type)) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      `unsupported collaboration message type ${String(input.type)}`,
    );
  }
  const text = input.text?.trim() ?? "";
  if (text.length === 0 || text.length > 8000) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "message text must be a non-empty string of at most 8000 characters",
    );
  }
  return deps.db.write(async (uow) => {
    const caller = await authenticateCaller(uow, authToken);
    const room = await uow.rooms.findById(input.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${input.roomId} does not exist`,
      );
    }
    const key = `room:message:${room.id}:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as SendMessageIdempotencyRecord | null;
    if (existing) {
      if (
        existing.type !== type ||
        existing.text !== text ||
        existing.replyToEventId !== input.replyToEventId ||
        existing.taskId !== input.taskId
      ) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used with a different message",
        );
      }
      return existing.event;
    }
    const membership = await uow.rooms.findMembership(room.id, caller.id);
    requireActiveMembership(membership, room, { requireOpen: true });
    const event = await appendEvent(deps, uow, {
      roomId: room.id,
      senderId: caller.id,
      type,
      payload: { text },
      replyToEventId: input.replyToEventId,
      taskId: input.taskId,
    });
    await uow.idempotency.save(key, {
      roomId: room.id,
      type,
      text,
      replyToEventId: input.replyToEventId,
      taskId: input.taskId,
      event,
    });
    return event;
  });
}

/** Cursor-based, ascending event read. Only active members may read. */
export async function listEvents(
  deps: CollaborationDeps,
  authToken: string,
  roomId: string,
  afterSequence = 0,
  limit = 100,
): Promise<RoomEvent[]> {
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "afterSequence must be a non-negative integer",
    );
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "limit must be a positive integer",
    );
  }
  const effectiveLimit = Math.min(limit, 200);
  return deps.db.read(async (uow) => {
    const caller = await authenticateCaller(uow, authToken);
    const room = await uow.rooms.findById(roomId);
    if (!room) {
      throw new DomainError("ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }
    const membership = await uow.rooms.findMembership(roomId, caller.id);
    requireActiveMembership(membership, room);
    return uow.events.listAfter(roomId, afterSequence, effectiveLimit);
  });
}

interface LeaveRoomIdempotencyRecord {
  roomId: string;
  returnedTaskIds: string[];
  membership: Membership;
}

/**
 * Mark the caller's membership `left` and release any tasks they still
 * own but have not completed, all before appending `member_left`.
 */
export async function leaveRoom(
  deps: CollaborationDeps,
  authToken: string,
  input: LeaveRoomInput,
): Promise<Membership> {
  return deps.db.write(async (uow) => {
    const caller = await authenticateCaller(uow, authToken);
    const room = await uow.rooms.findById(input.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${input.roomId} does not exist`,
      );
    }
    const membership = await uow.rooms.findMembership(room.id, caller.id);
    if (!membership) {
      throw new DomainError(
        "ROOM_MEMBERSHIP_REQUIRED",
        "only an active room member may leave a room",
      );
    }
    if (membership.state === "left" || membership.state === "removed") {
      return membership;
    }
    if (membership.state === "invited" || membership.state === "declined") {
      throw new DomainError(
        "INVITATION_NOT_ACCEPTED",
        "invitation must be accepted before leaving the room",
      );
    }
    const key = `room:leave:${room.id}:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as LeaveRoomIdempotencyRecord | null;
    if (existing) {
      return existing.membership;
    }
    requireActiveMembership(membership, room, { requireOpen: true });
    const now = deps.clock.now().toISOString();
    const returnedTaskIds: string[] = [];
    for (const task of await uow.tasks.listByRoom(room.id)) {
      if (task.ownerSessionId !== caller.id) continue;
      if (task.status !== "claimed" && task.status !== "blocked") continue;
      const released = {
        ...task,
        status: "open" as const,
        ownerSessionId: undefined,
        updatedAt: now,
      };
      delete released.ownerSessionId;
      await uow.tasks.update(released);
      returnedTaskIds.push(released.id);
      await appendEvent(deps, uow, {
        roomId: room.id,
        senderId: caller.id,
        type: "task_updated",
        payload: { task: released },
        taskId: released.id,
      });
    }
    const departed = membershipSchema.parse({
      ...membership,
      state: "left",
    });
    await uow.rooms.saveMembership(departed);
    await appendEvent(deps, uow, {
      roomId: room.id,
      senderId: caller.id,
      type: "member_left",
      payload: { returnedTaskIds },
    });
    await uow.idempotency.save(key, {
      roomId: room.id,
      returnedTaskIds,
      membership: departed,
    });
    return departed;
  });
}

interface CloseRoomIdempotencyRecord {
  roomId: string;
  summary: string;
  room: Room;
}

/**
 * Close the room with a final summary. The first successful close wins;
 * any later write fails `ROOM_CLOSED`, while a replay of the closing
 * idempotency key returns the original result.
 */
export async function closeRoom(
  deps: CollaborationDeps,
  authToken: string,
  input: CloseRoomInput,
): Promise<Room> {
  const summary = input.summary?.trim() ?? "";
  if (summary.length === 0 || summary.length > 5000) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "room summary must be a non-empty string of at most 5000 characters",
    );
  }
  return deps.db.write(async (uow) => {
    const caller = await authenticateCaller(uow, authToken);
    const room = await uow.rooms.findById(input.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${input.roomId} does not exist`,
      );
    }
    const key = `room:close:${room.id}:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as CloseRoomIdempotencyRecord | null;
    if (existing) {
      if (existing.summary !== summary) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used with a different summary",
        );
      }
      return existing.room;
    }
    const membership = await uow.rooms.findMembership(room.id, caller.id);
    requireActiveMembership(membership, room, { requireOpen: true });
    const closed = roomSchema.parse({
      ...room,
      status: "closed",
      contextSummary: summary,
    });
    await uow.rooms.update(closed);
    await appendEvent(deps, uow, {
      roomId: room.id,
      senderId: caller.id,
      type: "room_closed",
      payload: { summary },
    });
    await uow.idempotency.save(key, {
      roomId: room.id,
      summary,
      room: closed,
    });
    return closed;
  });
}
