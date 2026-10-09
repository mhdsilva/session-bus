import { DomainError } from "@session-bus/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import type { HubRuntime } from "../app.js";
import { authenticateBearer } from "../auth.js";
import { readBacklog } from "./websocket.js";

const querySchema = z.object({
  timeoutMs: z.coerce.number().int().min(0).max(30_000).default(25_000),
  afterByRoom: z.string().optional().default("{}"),
});

const cursorsSchema = z.record(z.string(), z.number().int().nonnegative());

export async function registerWaitRoute(
  app: FastifyInstance,
  runtime: HubRuntime,
): Promise<void> {
  app.get("/api/v1/events/wait", async (request) => {
    const { session } = await authenticateBearer(runtime.db, request);
    const query = querySchema.parse(request.query);
    let decodedCursors: unknown;
    try {
      decodedCursors = JSON.parse(query.afterByRoom);
    } catch {
      throw new DomainError(
        "INVALID_PAYLOAD",
        "afterByRoom must be valid JSON",
      );
    }
    const cursors = cursorsSchema.parse(decodedCursors);
    const initial = await readBacklog(runtime, session.id, cursors);
    if (initial.length > 0 || query.timeoutMs === 0) return { items: initial };

    const roomIds = await runtime.db.read(async (uow) =>
      (await uow.rooms.listMembershipsForSession(session.id))
        .filter((membership) => membership.state === "active")
        .map((membership) => membership.roomId),
    );
    const subscription = runtime.eventBroker.subscribe({
      sessionId: session.id,
      roomIds,
    });
    const iterator = subscription[Symbol.asyncIterator]();
    try {
      const handoff = await readBacklog(runtime, session.id, cursors);
      if (handoff.length > 0) return { items: handoff };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), query.timeoutMs);
      });
      const result = await Promise.race([iterator.next(), timeout]);
      if (timer) clearTimeout(timer);
      if (result === "timeout") return { items: [] };
      return { items: await readBacklog(runtime, session.id, cursors) };
    } finally {
      subscription.close();
    }
  });
}
