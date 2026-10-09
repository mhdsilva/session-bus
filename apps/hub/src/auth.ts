import type { Database, StoredSession } from "@session-bus/domain";
import { DomainError, hashToken } from "@session-bus/domain";
import type { FastifyRequest } from "fastify";

export function readBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) {
    throw new DomainError("AUTHENTICATION_FAILED", "Invalid session token");
  }
  return match[1];
}

export async function authenticateBearer(
  db: Database,
  request: FastifyRequest,
): Promise<{ token: string; session: StoredSession }> {
  const token = readBearerToken(request);
  const session = await db.read((uow) =>
    uow.sessions.findByTokenHash(hashToken(token)),
  );
  if (!session)
    throw new DomainError("AUTHENTICATION_FAILED", "Invalid session token");
  return { token, session };
}
