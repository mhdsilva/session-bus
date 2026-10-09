import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod/v4";
import type { HubRuntime } from "../app.js";
import { authenticateBearer } from "../auth.js";
import { OPERATOR_SESSION_ID } from "../operator-auth.js";
import { SlowConsumerError } from "./event-broker.js";

interface Ticket {
  sessionId: string;
  expiresAt: number;
}

export class WebSocketTicketStore {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly ttlMs = 30_000) {}

  issue(
    sessionId: string,
    now = Date.now(),
  ): { ticket: string; expiresAt: string } {
    this.removeExpired(now);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.tickets.set(ticket, { sessionId, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(ticket: string, now = Date.now()): string | null {
    const saved = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!saved || saved.expiresAt <= now) return null;
    return saved.sessionId;
  }

  private removeExpired(now: number): void {
    for (const [ticket, saved] of this.tickets) {
      if (saved.expiresAt <= now) this.tickets.delete(ticket);
    }
  }
}

const subscribeFrameSchema = z.object({
  type: z.literal("subscribe"),
  ticket: z.string().min(1),
  afterByRoom: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

function parseFirstFrame(data: unknown) {
  try {
    const raw =
      typeof data === "string"
        ? data
        : Buffer.from(data as ArrayBuffer).toString("utf8");
    return subscribeFrameSchema.safeParse(JSON.parse(raw));
  } catch {
    return { success: false as const };
  }
}

export async function readBacklog(
  runtime: HubRuntime,
  sessionId: string,
  cursors: Record<string, number>,
) {
  return runtime.db.read(async (uow) => {
    if (sessionId === OPERATOR_SESSION_ID) {
      const rooms = await uow.rooms.listRooms();
      const events = [];
      for (const room of rooms) {
        events.push(
          ...(await uow.events.listAfter(room.id, cursors[room.id] ?? 0)),
        );
      }
      return events.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence,
      );
    }
    const memberships = await uow.rooms.listMembershipsForSession(sessionId);
    const events = [];
    for (const membership of memberships) {
      if (membership.state !== "active" && membership.state !== "invited")
        continue;
      const roomEvents = await uow.events.listAfter(
        membership.roomId,
        cursors[membership.roomId] ?? 0,
      );
      events.push(
        ...roomEvents.filter(
          (event) =>
            membership.state === "active" ||
            ((event.type === "member_invited" ||
              event.type === "member_joined") &&
              event.payload.sessionId === sessionId),
        ),
      );
    }
    return events.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence,
    );
  });
}

function sendEvent(
  socket: WebSocket,
  event: Parameters<HubRuntime["eventBroker"]["publish"]>[0],
  sent: Set<string>,
) {
  if (sent.has(event.id) || socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > 1_048_576) {
    socket.close(1013, "slow consumer");
    return;
  }
  sent.add(event.id);
  if (sent.size > 10_000) sent.delete(sent.values().next().value as string);
  socket.send(JSON.stringify({ type: "event", event }));
}

export async function registerWebSocketRoutes(
  app: FastifyInstance,
  runtime: HubRuntime,
): Promise<void> {
  app.post("/api/v1/operator/ws-tickets", async (request, reply) => {
    if (!runtime.operator.sameOrigin(request))
      return reply.code(403).send({
        error: {
          code: "ORIGIN_FORBIDDEN",
          message: "Same-origin request required",
        },
      });
    if (!runtime.operator.matches(request))
      return reply.code(401).send({
        error: {
          code: "OPERATOR_AUTHENTICATION_FAILED",
          message: "Operator session required",
        },
      });
    reply.header("Cache-Control", "no-store");
    return runtime.webSocketTickets.issue(
      OPERATOR_SESSION_ID,
      runtime.clock.now().getTime(),
    );
  });

  app.post("/api/v1/ws-tickets", async (request, reply) => {
    const { session } = await authenticateBearer(runtime.db, request);
    reply.header("Cache-Control", "no-store");
    return runtime.webSocketTickets.issue(
      session.id,
      runtime.clock.now().getTime(),
    );
  });

  app.get(
    "/api/v1/ws",
    { websocket: true },
    (socket, _request: FastifyRequest) => {
      const client = socket as WebSocket;
      let subscription:
        | ReturnType<HubRuntime["eventBroker"]["subscribe"]>
        | undefined;
      const authTimeout = setTimeout(
        () => client.close(1008, "subscription frame required"),
        5_000,
      );
      client.once("message", async (data) => {
        const parsed = parseFirstFrame(data);
        if (!parsed.success) {
          clearTimeout(authTimeout);
          client.close(1008, "invalid subscription frame");
          return;
        }
        const sessionId = runtime.webSocketTickets.consume(
          parsed.data.ticket,
          runtime.clock.now().getTime(),
        );
        if (!sessionId) {
          clearTimeout(authTimeout);
          client.close(1008, "invalid or expired ticket");
          return;
        }
        clearTimeout(authTimeout);
        try {
          const initial = await readBacklog(
            runtime,
            sessionId,
            parsed.data.afterByRoom,
          );
          const activeRooms = await runtime.db.read(async (uow) => {
            if (sessionId === OPERATOR_SESSION_ID)
              return (await uow.rooms.listRooms()).map((room) => room.id);
            return (await uow.rooms.listMembershipsForSession(sessionId))
              .filter((membership) => membership.state === "active")
              .map((membership) => membership.roomId);
          });
          subscription = runtime.eventBroker.subscribe({
            sessionId,
            roomIds: activeRooms,
            queueLimit: 256,
          });
          const overlap = await readBacklog(
            runtime,
            sessionId,
            parsed.data.afterByRoom,
          );
          const sent = new Set<string>();
          for (const event of [...initial, ...overlap])
            sendEvent(client, event, sent);
          if (client.readyState === client.OPEN)
            client.send(JSON.stringify({ type: "ready" }));
          for await (const event of subscription) {
            sendEvent(client, event, sent);
            if (client.readyState !== client.OPEN) break;
          }
        } catch (error) {
          if (error instanceof SlowConsumerError)
            client.close(1013, "slow consumer");
          else if (client.readyState === client.OPEN)
            client.close(1011, "event delivery failed");
        } finally {
          subscription?.close();
        }
      });
      client.once("close", () => subscription?.close());
      client.once("error", () => subscription?.close());
    },
  );
}
