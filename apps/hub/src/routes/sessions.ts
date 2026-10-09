import {
  DomainError,
  expirePresence,
  hashToken,
  heartbeat,
  registerSession,
  stripTokenHash,
} from "@session-bus/domain";
import {
  sessionProfileSchema,
  sessionStatusSchema,
} from "@session-bus/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import type { HubDependencies } from "../app.js";
import { authenticateBearer } from "../auth.js";
import { OPERATOR_SESSION_ID } from "../operator-auth.js";

const heartbeatSchema = z
  .object({ status: sessionStatusSchema.optional() })
  .default({});

export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: HubDependencies,
): Promise<void> {
  app.post("/api/v1/sessions", async (request, reply) => {
    const profile = sessionProfileSchema.parse(request.body);
    const registered = await registerSession(deps, profile);
    reply.header("Cache-Control", "no-store");
    return reply
      .code(201)
      .send({ session: registered.session, instanceToken: registered.token });
  });

  app.post("/api/v1/sessions/heartbeat", async (request) => {
    const { token, session: current } = await authenticateBearer(
      deps.db,
      request,
    );
    const body = heartbeatSchema.parse(request.body ?? {});
    const status =
      body.status ??
      (current.status === "offline" ? "available" : current.status);
    const session = await heartbeat(deps, token, status);
    return { session };
  });

  app.patch("/api/v1/sessions/me", async (request) => {
    const profile = sessionProfileSchema.parse(request.body);
    const { token, session: current } = await authenticateBearer(
      deps.db,
      request,
    );
    const updated = await deps.db.write(async (uow) => {
      const existing = await uow.sessions.findByTokenHash(hashToken(token));
      if (!existing || existing.id !== current.id)
        throw new DomainError("AUTHENTICATION_FAILED", "Invalid session token");
      const next = {
        ...existing,
        ...profile,
        lastSeenAt: deps.clock.now().toISOString(),
      };
      await uow.sessions.update(next);
      return stripTokenHash(next);
    });
    return { session: updated };
  });

  app.get("/api/v1/sessions", async (request) => {
    await authenticateBearer(deps.db, request);
    await expirePresence(deps, deps.config.presenceTtlMs);
    const sessions = await deps.db.read((uow) => uow.sessions.listAll());
    return {
      items: sessions
        .filter((session) => session.id !== OPERATOR_SESSION_ID)
        .map(stripTokenHash),
    };
  });
}
