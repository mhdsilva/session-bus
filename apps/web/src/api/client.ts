import {
  type Artifact,
  artifactSchema,
  type Membership,
  membershipSchema,
  type Room,
  type RoomEvent,
  roomEventSchema,
  roomSchema,
  type Session,
  type SharedTask,
  sessionSchema,
  sharedTaskSchema,
} from "@session-bus/protocol";
import { z } from "zod/v4";
import type { ObserverApi, OperatorRoomContext } from "../types.js";

const roomsResponseSchema = z.object({
  items: z.array(
    z.object({ room: roomSchema, memberships: z.array(membershipSchema) }),
  ),
});
const sessionsResponseSchema = z.object({ items: z.array(sessionSchema) });
const contextResponseSchema = z.object({
  context: z.object({
    room: roomSchema,
    memberships: z.array(membershipSchema),
    events: z.array(roomEventSchema),
    tasks: z.array(sharedTaskSchema),
    artifacts: z.array(artifactSchema),
  }),
});
const ticketResponseSchema = z.object({ ticket: z.string().min(1) });
const messageResponseSchema = z.object({ event: roomEventSchema });

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok)
    throw new Error(`Session Bus request failed (${response.status})`);
  if (response.status === 204) return schema.parse({});
  return schema.parse(await response.json());
}

export function createObserverApi(): ObserverApi {
  return {
    async bootstrap() {
      const response = await fetch("/api/v1/operator/bootstrap", {
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error(
          `Could not initialize local operator session (${response.status})`,
        );
    },
    async listSessions(): Promise<Session[]> {
      return (
        await request("/api/v1/operator/sessions", sessionsResponseSchema)
      ).items;
    },
    async listRooms() {
      return (await request("/api/v1/operator/rooms", roomsResponseSchema))
        .items;
    },
    async getRoomContext(roomId: string): Promise<OperatorRoomContext> {
      return (
        await request(
          `/api/v1/operator/rooms/${roomId}/context`,
          contextResponseSchema,
        )
      ).context;
    },
    async listEvents(roomId: string, after: number): Promise<RoomEvent[]> {
      const context = await request(
        `/api/v1/operator/rooms/${roomId}/context`,
        contextResponseSchema,
      );
      return context.context.events
        .filter((event) => event.sequence > after)
        .slice(0, 200);
    },
    async createWsTicket() {
      return (
        await request("/api/v1/operator/ws-tickets", ticketResponseSchema, {
          method: "POST",
        })
      ).ticket;
    },
    async postMessage(roomId: string, text: string) {
      const response = await request(
        `/api/v1/operator/rooms/${roomId}/messages`,
        messageResponseSchema,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ text }),
        },
      );
      return response.event;
    },
  };
}

export type { Artifact, Membership, Room, RoomEvent, Session, SharedTask };
