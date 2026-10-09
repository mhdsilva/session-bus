import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isLoopbackHost } from "./config.js";

export const OPERATOR_COOKIE = "session_bus_operator";
export const OPERATOR_SESSION_ID = "00000000-0000-4000-8000-000000000001";

export function createOperatorAuthenticator(app: FastifyInstance) {
  const token = randomBytes(32).toString("hex");
  const matches = (request: FastifyRequest): boolean => {
    const candidate = request.cookies[OPERATOR_COOKIE];
    if (!candidate || candidate.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
  };
  const sameOrigin = (request: FastifyRequest): boolean => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (!origin || !host) return false;
    try {
      const parsed = new URL(origin);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.host.toLowerCase() === host.toLowerCase() &&
        isLoopbackHost(parsed.hostname)
      );
    } catch {
      return false;
    }
  };
  app.get("/api/v1/operator/bootstrap", async (request, reply) => {
    if (!sameOrigin(request))
      return reply.code(403).send({
        error: {
          code: "ORIGIN_FORBIDDEN",
          message: "Same-origin request required",
        },
      });
    reply.header("Cache-Control", "no-store");
    reply.setCookie(OPERATOR_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
    });
    return reply.code(204).send();
  });
  return { matches, sameOrigin };
}
