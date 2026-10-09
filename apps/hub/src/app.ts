import cookie from "@fastify/cookie";
import {
  type Clock,
  type Database,
  expirePresence,
  type IdGenerator,
  stripTokenHash,
} from "@session-bus/domain";
import Fastify, { type FastifyInstance } from "fastify";
import type { HubConfig } from "./config.js";
import { registerErrorHandler } from "./errors.js";
import { createOperatorAuthenticator } from "./operator-auth.js";
import { registerSessionRoutes } from "./routes/sessions.js";

export interface HubDependencies {
  db: Database;
  clock: Clock;
  ids: IdGenerator;
  config: HubConfig;
}

export async function buildHubApp(
  deps: HubDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false });
  await app.register(cookie);
  registerErrorHandler(app);
  await registerSessionRoutes(app, deps);
  const operator = createOperatorAuthenticator(app);
  app.get("/api/v1/operator/sessions", async (request, reply) => {
    if (!operator.sameOrigin(request))
      return reply.code(403).send({
        error: {
          code: "ORIGIN_FORBIDDEN",
          message: "Same-origin request required",
        },
      });
    if (!operator.matches(request))
      return reply.code(401).send({
        error: {
          code: "OPERATOR_AUTHENTICATION_FAILED",
          message: "Operator session required",
        },
      });
    await expirePresence(deps, deps.config.presenceTtlMs);
    const sessions = await deps.db.read((uow) => uow.sessions.listAll());
    return { items: sessions.map(stripTokenHash) };
  });
  return app;
}
