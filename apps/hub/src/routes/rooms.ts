import {
  appendEvent,
  claimTask,
  closeRoom,
  createRoom,
  createTask,
  DomainError,
  getRoomContext,
  inviteSessions,
  leaveRoom,
  listEvents,
  publishArtifact,
  respondToInvitation,
  sendMessage,
  updateTask,
} from "@session-bus/domain";
import type { RoomEvent } from "@session-bus/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import type { HubRuntime } from "../app.js";
import { authenticateBearer } from "../auth.js";
import { OPERATOR_SESSION_ID } from "../operator-auth.js";

const roomParams = z.object({ id: z.uuid() });
const taskParams = z.object({ id: z.uuid() });
const createRoomBody = z.object({ title: z.string(), objective: z.string() });
const inviteBody = z.object({ sessionIds: z.array(z.uuid()).min(1).max(64) });
const respondBody = z.object({ accept: z.boolean() });
const messageBody = z.object({
  type: z
    .enum(["message", "question", "decision", "conflict_reported"])
    .optional(),
  text: z.string().trim().min(1).max(8000),
  replyToEventId: z.uuid().optional(),
  taskId: z.uuid().optional(),
});
const taskBody = z.object({
  title: z.string(),
  description: z.string().optional(),
});
const updateTaskBody = z.object({
  status: z.enum(["blocked", "completed", "cancelled"]),
  resultSummary: z.string().optional(),
});
const artifactBody = z.object({
  kind: z.string(),
  uri: z.string(),
  summary: z.string().optional(),
  contentHash: z.string().optional(),
});
const closeBody = z.object({ summary: z.string() });
const eventQuery = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 200
  ) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "Idempotency-Key header is required",
    );
  }
  return value.trim();
}

async function wasReplayed(runtime: HubRuntime, key: string): Promise<boolean> {
  return runtime.db.read(
    async (uow) => (await uow.idempotency.find(key)) !== null,
  );
}

async function lastSequence(
  runtime: HubRuntime,
  roomId: string,
): Promise<number> {
  return runtime.db.read(async (uow) => {
    const events = await uow.events.listByRoom(roomId);
    return events.at(-1)?.sequence ?? 0;
  });
}

async function memberSequences(
  runtime: HubRuntime,
  sessionId: string,
): Promise<Map<string, number>> {
  return runtime.db.read(async (uow) => {
    const sequences = new Map<string, number>();
    for (const membership of await uow.rooms.listMembershipsForSession(
      sessionId,
    )) {
      if (membership.state !== "active") continue;
      const events = await uow.events.listByRoom(membership.roomId);
      sequences.set(membership.roomId, events.at(-1)?.sequence ?? 0);
    }
    return sequences;
  });
}

async function publishCommittedSince(
  runtime: HubRuntime,
  roomId: string,
  sequence: number,
): Promise<void> {
  const committed = await runtime.db.read((uow) =>
    uow.events.listAfter(roomId, sequence),
  );
  for (const event of committed) runtime.eventBroker.publish(event);
}

function operatorGuard(
  runtime: HubRuntime,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (!runtime.operator.sameOrigin(request)) {
    void reply.code(403).send({
      error: {
        code: "ORIGIN_FORBIDDEN",
        message: "Same-origin request required",
      },
    });
    return false;
  }
  if (!runtime.operator.matches(request)) {
    void reply.code(401).send({
      error: {
        code: "OPERATOR_AUTHENTICATION_FAILED",
        message: "Operator session required",
      },
    });
    return false;
  }
  return true;
}

export async function registerCollaborationRoutes(
  app: FastifyInstance,
  runtime: HubRuntime,
): Promise<void> {
  app.get("/api/v1/rooms", async (request) => {
    const { session } = await authenticateBearer(runtime.db, request);
    const memberships = await runtime.db.read((uow) =>
      uow.rooms.listMembershipsForSession(session.id),
    );
    const items = await runtime.db.read(async (uow) => {
      const result = [];
      for (const membership of memberships) {
        const room = await uow.rooms.findById(membership.roomId);
        if (room) result.push({ room, membership });
      }
      return result;
    });
    return { items };
  });

  app.get("/api/v1/invitations", async (request) => {
    const { session } = await authenticateBearer(runtime.db, request);
    const items = await runtime.db.read(async (uow) => {
      const result = [];
      for (const membership of await uow.rooms.listMembershipsForSession(
        session.id,
      )) {
        if (membership.state !== "invited") continue;
        const room = await uow.rooms.findById(membership.roomId);
        if (room) result.push({ room, membership });
      }
      return result;
    });
    return { items };
  });

  app.post("/api/v1/rooms", async (request, reply) => {
    const { session, token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const body = createRoomBody.parse(request.body);
    const replay = await wasReplayed(
      runtime,
      `room:create:${session.id}:${key}`,
    );
    const room = await createRoom(runtime, token, {
      ...body,
      idempotencyKey: key,
    });
    return reply.code(replay ? 200 : 201).send({ room });
  });

  app.post("/api/v1/rooms/:id/invitations", async (request, reply) => {
    const { id } = roomParams.parse(request.params);
    const { session, token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const body = inviteBody.parse(request.body);
    const dbKey = `room:invite:${id}:${session.id}:${key}`;
    const replay = await wasReplayed(runtime, dbKey);
    const before = await lastSequence(runtime, id);
    const memberships = await inviteSessions(runtime, token, {
      roomId: id,
      sessionIds: body.sessionIds,
      idempotencyKey: key,
    });
    await publishCommittedSince(runtime, id, before);
    return reply.code(replay ? 200 : 201).send({ items: memberships });
  });

  app.post("/api/v1/rooms/:id/invitation", async (request) => {
    const { id } = roomParams.parse(request.params);
    const { session, token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const body = respondBody.parse(request.body);
    const replay = await wasReplayed(
      runtime,
      `room:respond:${id}:${session.id}:${key}`,
    );
    const before = await lastSequence(runtime, id);
    const membership = await respondToInvitation(runtime, token, {
      roomId: id,
      accept: body.accept,
      idempotencyKey: key,
    });
    await publishCommittedSince(runtime, id, before);
    return { membership, replayed: replay };
  });

  app.get("/api/v1/rooms/:id/context", async (request) => {
    const { id } = roomParams.parse(request.params);
    const { token } = await authenticateBearer(runtime.db, request);
    return { context: await getRoomContext(runtime, token, id) };
  });

  app.get("/api/v1/rooms/:id/events", async (request) => {
    const { id } = roomParams.parse(request.params);
    const { token } = await authenticateBearer(runtime.db, request);
    const { after, limit } = eventQuery.parse(request.query);
    const items = await listEvents(runtime, token, id, after, limit);
    return {
      items,
      nextCursor: {
        roomId: id,
        afterSequence: items.at(-1)?.sequence ?? after,
      },
    };
  });

  app.post("/api/v1/rooms/:id/messages", async (request, reply) => {
    const { id } = roomParams.parse(request.params);
    const { session, token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const body = messageBody.parse(request.body);
    const replay = await wasReplayed(
      runtime,
      `room:message:${id}:${session.id}:${key}`,
    );
    const before = await lastSequence(runtime, id);
    const event = await sendMessage(runtime, token, {
      roomId: id,
      ...body,
      idempotencyKey: key,
    });
    await publishCommittedSince(runtime, id, before);
    return reply.code(replay ? 200 : 201).send({ event });
  });

  app.post("/api/v1/rooms/:id/tasks", async (request, reply) => {
    const { id } = roomParams.parse(request.params);
    const { session, token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const body = taskBody.parse(request.body);
    const replay = await wasReplayed(
      runtime,
      `room:task:create:${id}:${session.id}:${key}`,
    );
    const before = await lastSequence(runtime, id);
    const task = await createTask(runtime, token, {
      roomId: id,
      ...body,
      idempotencyKey: key,
    });
    await publishCommittedSince(runtime, id, before);
    return reply.code(replay ? 200 : 201).send({ task });
  });

  app.post("/api/v1/tasks/:id/claim", async (request, reply) => {
    const { id } = taskParams.parse(request.params);
    const { session, token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const beforeByRoom = await memberSequences(runtime, session.id);
    const updated = await claimTask(runtime, token, {
      taskId: id,
      idempotencyKey: key,
    });
    await publishCommittedSince(
      runtime,
      updated.roomId,
      beforeByRoom.get(updated.roomId) ?? 0,
    );
    return reply.code(200).send({ task: updated });
  });

  app.patch("/api/v1/tasks/:id", async (request, reply) => {
    const { id } = taskParams.parse(request.params);
    const { session, token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const body = updateTaskBody.parse(request.body);
    const beforeByRoom = await memberSequences(runtime, session.id);
    const updated = await updateTask(runtime, token, {
      taskId: id,
      ...body,
      idempotencyKey: key,
    });
    await publishCommittedSince(
      runtime,
      updated.roomId,
      beforeByRoom.get(updated.roomId) ?? 0,
    );
    return reply.code(200).send({ task: updated });
  });

  app.get("/api/v1/rooms/:id/tasks", async (request) => {
    const { id } = roomParams.parse(request.params);
    const { token } = await authenticateBearer(runtime.db, request);
    const context = await getRoomContext(runtime, token, id);
    return { items: context.tasks };
  });
  app.get("/api/v1/rooms/:id/artifacts", async (request) => {
    const { id } = roomParams.parse(request.params);
    const { token } = await authenticateBearer(runtime.db, request);
    const context = await getRoomContext(runtime, token, id);
    return { items: context.artifacts };
  });

  app.post("/api/v1/rooms/:id/artifacts", async (request, reply) => {
    const { id } = roomParams.parse(request.params);
    const { session, token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const body = artifactBody.parse(request.body);
    const replay = await wasReplayed(
      runtime,
      `room:artifact:${id}:${session.id}:${key}`,
    );
    const before = await lastSequence(runtime, id);
    const artifact = await publishArtifact(runtime, token, {
      roomId: id,
      ...body,
      idempotencyKey: key,
    });
    await publishCommittedSince(runtime, id, before);
    return reply.code(replay ? 200 : 201).send({ artifact });
  });

  app.post("/api/v1/rooms/:id/leave", async (request, reply) => {
    const { id } = roomParams.parse(request.params);
    const { token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const before = await lastSequence(runtime, id);
    const membership = await leaveRoom(runtime, token, {
      roomId: id,
      idempotencyKey: key,
    });
    await publishCommittedSince(runtime, id, before);
    return reply.code(200).send({ membership });
  });

  app.post("/api/v1/rooms/:id/close", async (request, reply) => {
    const { id } = roomParams.parse(request.params);
    const { token } = await authenticateBearer(runtime.db, request);
    const key = idempotencyKey(request);
    const before = await lastSequence(runtime, id);
    const body = closeBody.parse(request.body);
    const room = await closeRoom(runtime, token, {
      roomId: id,
      ...body,
      idempotencyKey: key,
    });
    await publishCommittedSince(runtime, id, before);
    return reply.code(200).send({ room });
  });

  app.get("/api/v1/operator/rooms", async (request, reply) => {
    if (!operatorGuard(runtime, request, reply)) return;
    const items = await runtime.db.read(async (uow) =>
      Promise.all(
        (await uow.rooms.listRooms()).map(async (room) => ({
          room,
          memberships: await uow.rooms.listMemberships(room.id),
        })),
      ),
    );
    return { items };
  });

  app.get("/api/v1/operator/rooms/:id/context", async (request, reply) => {
    if (!operatorGuard(runtime, request, reply)) return;
    const { id } = roomParams.parse(request.params);
    const data = await runtime.db.read(async (uow) => {
      const room = await uow.rooms.findById(id);
      if (!room)
        throw new DomainError("ROOM_NOT_FOUND", `room ${id} does not exist`);
      return {
        room,
        memberships: await uow.rooms.listMemberships(id),
        events: await uow.events.listByRoom(id),
        tasks: await uow.tasks.listByRoom(id),
        artifacts: await uow.artifacts.listByRoom(id),
      };
    });
    return { context: data };
  });

  app.post("/api/v1/operator/rooms/:id/messages", async (request, reply) => {
    if (!operatorGuard(runtime, request, reply)) return;
    const { id } = roomParams.parse(request.params);
    const key = idempotencyKey(request);
    const body = messageBody
      .pick({ type: true, text: true })
      .parse(request.body);
    const dbKey = `operator:room:message:${id}:${key}`;
    const result = await runtime.db.write(async (uow) => {
      const existing = (await uow.idempotency.find(dbKey)) as {
        event: unknown;
        type: string;
        text: string;
      } | null;
      if (existing) {
        if (
          existing.type !== (body.type ?? "message") ||
          existing.text !== body.text
        ) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "idempotency key was already used with a different message",
          );
        }
        return {
          event: existing.event,
          replayed: true,
        };
      }
      const room = await uow.rooms.findById(id);
      if (!room)
        throw new DomainError("ROOM_NOT_FOUND", `room ${id} does not exist`);
      if (room.status !== "open")
        throw new DomainError("ROOM_CLOSED", `room ${id} is ${room.status}`);
      const created = await appendEvent(runtime, uow, {
        roomId: id,
        senderId: OPERATOR_SESSION_ID,
        type: body.type ?? "message",
        payload: { text: body.text },
      });
      await uow.idempotency.save(dbKey, {
        event: created,
        type: body.type ?? "message",
        text: body.text,
      });
      return { event: created, replayed: false };
    });
    if (!result.replayed)
      runtime.eventBroker.publish(result.event as RoomEvent);
    return reply
      .code(result.replayed ? 200 : 201)
      .send({ event: result.event });
  });
}
