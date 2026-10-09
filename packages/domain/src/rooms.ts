import {
  type Membership,
  membershipSchema,
  type Room,
  type RoomContext,
  roomContextSchema,
  roomSchema,
  type Session,
} from "@session-bus/protocol";
import type { Clock } from "./clock.js";
import { DomainError } from "./errors.js";
import { appendEvent } from "./events.js";
import type { IdGenerator } from "./ids.js";
import type { Database, StoredSession, UnitOfWork } from "./repositories.js";
import { hashToken, stripTokenHash } from "./sessions.js";

export interface RoomDeps {
  db: Database;
  clock: Clock;
  ids: IdGenerator;
}

export interface CreateRoomInput {
  title: string;
  objective: string;
  idempotencyKey: string;
}

export interface InviteSessionsInput {
  roomId: string;
  sessionIds: string[];
  idempotencyKey: string;
}

export interface RespondToInvitationInput {
  roomId: string;
  accept: boolean;
  idempotencyKey?: string;
}

interface RespondToInvitationIdempotencyRecord {
  accept: boolean;
  membership: Membership;
}

interface CreateRoomIdempotencyRecord {
  title: string;
  objective: string;
  room: Room;
}

interface InviteSessionsIdempotencyRecord {
  sessionIds: string[];
  memberships: Membership[];
}

async function authenticate(
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

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const remaining = new Set(a);
  for (const value of b) {
    if (!remaining.delete(value)) return false;
  }
  return remaining.size === 0;
}

/**
 * Create a room and make the creator an active member in the same
 * transaction, so a room never exists without its owner.
 */
export async function createRoom(
  deps: RoomDeps,
  authToken: string,
  input: CreateRoomInput,
): Promise<Room> {
  return deps.db.write(async (uow) => {
    const caller = await authenticate(uow, authToken);
    const key = `room:create:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as CreateRoomIdempotencyRecord | null;
    if (existing) {
      if (
        existing.title !== input.title ||
        existing.objective !== input.objective
      ) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used with different room parameters",
        );
      }
      return existing.room;
    }
    const now = deps.clock.now().toISOString();
    const room = roomSchema.parse({
      id: deps.ids.next(),
      title: input.title,
      objective: input.objective,
      status: "open",
      createdBy: caller.id,
      createdAt: now,
      contextSummary: "",
    });
    const membership = membershipSchema.parse({
      roomId: room.id,
      sessionId: caller.id,
      state: "active",
      role: "owner",
      joinedAt: now,
      lastReadSequence: 0,
    });
    await uow.rooms.insert(room);
    await uow.rooms.saveMembership(membership);
    await uow.idempotency.save(key, {
      title: input.title,
      objective: input.objective,
      room,
    });
    return room;
  });
}

/**
 * Invite sessions into a room. Only an active member may invite, and
 * invites create pending memberships: invited sessions learn nothing
 * of the full context until they accept.
 */
export async function inviteSessions(
  deps: RoomDeps,
  authToken: string,
  input: InviteSessionsInput,
): Promise<Membership[]> {
  return deps.db.write(async (uow) => {
    const caller = await authenticate(uow, authToken);
    const room = await uow.rooms.findById(input.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${input.roomId} does not exist`,
      );
    }
    if (room.status !== "open") {
      throw new DomainError("ROOM_CLOSED", `room ${room.id} is ${room.status}`);
    }
    const callerMembership = await uow.rooms.findMembership(room.id, caller.id);
    if (callerMembership?.state !== "active") {
      throw new DomainError(
        "ROOM_MEMBERSHIP_REQUIRED",
        "only an active room member may invite other sessions",
      );
    }
    const key = `room:invite:${room.id}:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as InviteSessionsIdempotencyRecord | null;
    if (existing) {
      if (!sameStringSet(existing.sessionIds, input.sessionIds)) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used with a different invitee set",
        );
      }
      return existing.memberships;
    }
    const now = deps.clock.now().toISOString();
    const memberships: Membership[] = [];
    for (const sessionId of input.sessionIds) {
      const target = await uow.sessions.findById(sessionId);
      if (!target) {
        throw new DomainError(
          "INVALID_TRANSITION",
          `cannot invite unknown session ${sessionId}`,
        );
      }
      const current = await uow.rooms.findMembership(room.id, sessionId);
      if (
        current &&
        (current.state === "active" || current.state === "invited")
      ) {
        memberships.push(current);
        continue;
      }
      const membership = membershipSchema.parse({
        roomId: room.id,
        sessionId,
        state: "invited",
        role: "",
        joinedAt: now,
        lastReadSequence: 0,
      });
      await uow.rooms.saveMembership(membership);
      memberships.push(membership);
      await appendEvent(deps, uow, {
        roomId: room.id,
        senderId: caller.id,
        type: "member_invited",
        payload: { sessionId },
      });
    }
    await uow.idempotency.save(key, {
      sessionIds: [...input.sessionIds],
      memberships,
    });
    return memberships;
  });
}

/**
 * Accept or decline an invitation. Only the invited session itself may
 * call, and the pending invitation transitions exactly once.
 */
export async function respondToInvitation(
  deps: RoomDeps,
  authToken: string,
  input: RespondToInvitationInput,
): Promise<Membership> {
  return deps.db.write(async (uow) => {
    const caller = await authenticate(uow, authToken);
    const room = await uow.rooms.findById(input.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${input.roomId} does not exist`,
      );
    }
    const key = input.idempotencyKey
      ? `room:respond:${room.id}:${caller.id}:${input.idempotencyKey}`
      : undefined;
    if (key) {
      const existing = (await uow.idempotency.find(
        key,
      )) as RespondToInvitationIdempotencyRecord | null;
      if (existing) {
        if (existing.accept !== input.accept) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "idempotency key was already used for a different invitation response",
          );
        }
        return existing.membership;
      }
    }
    if (room.status !== "open") {
      throw new DomainError("ROOM_CLOSED", `room ${room.id} is ${room.status}`);
    }
    const membership = await uow.rooms.findMembership(room.id, caller.id);
    if (!membership) {
      throw new DomainError(
        "INVITATION_NOT_ACCEPTED",
        "no invitation exists for this session in the room",
      );
    }
    if (membership.state !== "invited") {
      throw new DomainError(
        "INVALID_TRANSITION",
        `invitation already resolved as ${membership.state}`,
      );
    }
    const nextState: Membership["state"] = input.accept ? "active" : "declined";
    const updated = membershipSchema.parse({
      ...membership,
      state: nextState,
      joinedAt: deps.clock.now().toISOString(),
    });
    await uow.rooms.saveMembership(updated);
    if (input.accept) {
      await appendEvent(deps, uow, {
        roomId: room.id,
        senderId: caller.id,
        type: "member_joined",
        payload: { sessionId: caller.id },
      });
    }
    if (key) {
      await uow.idempotency.save(key, {
        accept: input.accept,
        membership: updated,
      });
    }
    return updated;
  });
}

/**
 * Read the full room context. Active members only: pending invitees
 * get INVITATION_NOT_ACCEPTED, outsiders get ROOM_MEMBERSHIP_REQUIRED.
 */
export async function getRoomContext(
  deps: RoomDeps,
  authToken: string,
  roomId: string,
): Promise<RoomContext> {
  return deps.db.read(async (uow) => {
    const caller = await authenticate(uow, authToken);
    const room = await uow.rooms.findById(roomId);
    if (!room) {
      throw new DomainError("ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }
    const membership = await uow.rooms.findMembership(roomId, caller.id);
    if (membership?.state !== "active") {
      if (membership?.state === "invited" || membership?.state === "declined") {
        throw new DomainError(
          "INVITATION_NOT_ACCEPTED",
          "invitation must be accepted before reading room context",
        );
      }
      throw new DomainError(
        "ROOM_MEMBERSHIP_REQUIRED",
        "only an active room member may read room context",
      );
    }
    const memberships = await uow.rooms.listMemberships(roomId);
    const participants: Session[] = [];
    for (const entry of memberships) {
      if (entry.state !== "active") continue;
      const stored = await uow.sessions.findById(entry.sessionId);
      if (stored) participants.push(stripTokenHash(stored));
    }
    const events = await uow.events.listByRoom(roomId);
    const tasks = await uow.tasks.listByRoom(roomId);
    const artifacts = await uow.artifacts.listByRoom(roomId);
    const lastSequence = events.reduce(
      (max, event) => Math.max(max, event.sequence),
      0,
    );
    return roomContextSchema.parse({
      room,
      participants,
      memberships,
      decisions: events.filter((event) => event.type === "decision"),
      tasks,
      artifacts,
      recentEvents: events.slice(-50),
      nextCursor: { roomId, afterSequence: lastSequence },
    });
  });
}
