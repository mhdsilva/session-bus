import { DomainError } from "@session-bus/domain";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod/v4";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      const status =
        error.code === "AUTHENTICATION_FAILED"
          ? 401
          : error.code === "ROOM_NOT_FOUND" || error.code === "TASK_NOT_FOUND"
            ? 404
            : error.code === "ROOM_MEMBERSHIP_REQUIRED" ||
                error.code === "INVITATION_NOT_ACCEPTED"
              ? 403
              : error.code === "ROOM_CLOSED" ||
                  error.code === "INVALID_TRANSITION" ||
                  error.code === "IDEMPOTENCY_CONFLICT"
                ? 409
                : 400;
      return reply
        .code(status)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Request payload is invalid",
        },
      });
    }
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });
}
