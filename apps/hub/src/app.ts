import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
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
import {
  createOperatorAuthenticator,
  OPERATOR_SESSION_ID,
} from "./operator-auth.js";
import { EventBroker } from "./realtime/event-broker.js";
import { registerWaitRoute } from "./realtime/wait.js";
import {
  registerWebSocketRoutes,
  WebSocketTicketStore,
} from "./realtime/websocket.js";
import { registerCollaborationRoutes } from "./routes/rooms.js";
import { registerSessionRoutes } from "./routes/sessions.js";

export interface HubDependencies {
  db: Database;
  clock: Clock;
  ids: IdGenerator;
  config: HubConfig;
}

export interface HubRuntime extends HubDependencies {
  eventBroker: EventBroker;
  webSocketTickets: WebSocketTicketStore;
  operator: ReturnType<typeof createOperatorAuthenticator>;
}

async function ensureOperatorSession(deps: HubDependencies): Promise<void> {
  await deps.db.write(async (uow) => {
    if (await uow.sessions.findById(OPERATOR_SESSION_ID)) return;
    await uow.sessions.insert({
      id: OPERATOR_SESSION_ID,
      name: "Local operator",
      harness: { name: "session-bus", version: "1" },
      projectRoot: "/",
      capabilities: [],
      currentFocus: "",
      metadata: { kind: "local-operator" },
      status: "available",
      lastSeenAt: deps.clock.now().toISOString(),
      tokenHash: randomBytes(32).toString("hex"),
    });
  });
}

export async function buildHubApp(
  deps: HubDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false });
  await app.register(cookie);
  await app.register(websocket);
  registerErrorHandler(app);
  await ensureOperatorSession(deps);
  await registerSessionRoutes(app, deps);
  const operator = createOperatorAuthenticator(app);
  const runtime: HubRuntime = {
    ...deps,
    operator,
    eventBroker: new EventBroker(),
    webSocketTickets: new WebSocketTicketStore(),
  };
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
    return {
      items: sessions
        .filter((session) => session.id !== OPERATOR_SESSION_ID)
        .map(stripTokenHash),
    };
  });
  await registerCollaborationRoutes(app, runtime);
  await registerWebSocketRoutes(app, runtime);
  await registerWaitRoute(app, runtime);
  return app;
}
