import { createHash, randomBytes } from "node:crypto";
import {
  type Session,
  type SessionProfile,
  type SessionStatus,
  sessionProfileSchema,
  sessionSchema,
} from "@session-bus/protocol";
import type { Clock } from "./clock.js";
import { DomainError } from "./errors.js";
import type { IdGenerator } from "./ids.js";
import type { Database, StoredSession, UnitOfWork } from "./repositories.js";

export interface SessionDeps {
  db: Database;
  clock: Clock;
  ids: IdGenerator;
  generateToken?: () => string;
}

export interface RegisteredSession {
  session: Session;
  /** Plaintext instance token, returned exactly once at registration. */
  token: string;
}

/** Sessions that missed heartbeats for longer than this are marked offline. */
export const DEFAULT_PRESENCE_TIMEOUT_MS = 90_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function defaultGenerateToken(): string {
  return randomBytes(32).toString("hex");
}

export function stripTokenHash(stored: StoredSession): Session {
  const { tokenHash: _tokenHash, ...session } = stored;
  return session;
}

async function authenticateIn(
  uow: UnitOfWork,
  token: string,
): Promise<StoredSession> {
  const found = await uow.sessions.findByTokenHash(hashToken(token));
  if (!found) {
    throw new DomainError(
      "AUTHENTICATION_FAILED",
      "invalid or unknown instance token",
    );
  }
  return found;
}

/**
 * Register a session: create a random instance token, store only its
 * SHA-256 hash, and return the plaintext once. Identity always derives
 * from the token afterwards, never from a caller-supplied sender id.
 */
export async function registerSession(
  deps: SessionDeps,
  profile: SessionProfile,
): Promise<RegisteredSession> {
  const validated = sessionProfileSchema.parse(profile);
  const token = (deps.generateToken ?? defaultGenerateToken)();
  const now = deps.clock.now().toISOString();
  const session = sessionSchema.parse({
    ...validated,
    id: deps.ids.next(),
    status: "available",
    lastSeenAt: now,
  });
  const stored: StoredSession = { ...session, tokenHash: hashToken(token) };
  await deps.db.write(async (uow) => {
    await uow.sessions.insert(stored);
  });
  return { session, token };
}

/** Resolve the session behind a presented instance token. */
export async function authenticateSession(
  db: Database,
  token: string,
): Promise<Session> {
  return db.read(async (uow) =>
    stripTokenHash(await authenticateIn(uow, token)),
  );
}

/** Record a heartbeat: refresh lastSeenAt and optionally update status. */
export async function heartbeat(
  deps: SessionDeps,
  token: string,
  status?: SessionStatus,
): Promise<Session> {
  return deps.db.write(async (uow) => {
    const stored = await authenticateIn(uow, token);
    const updated: StoredSession = {
      ...stored,
      status: status ?? stored.status,
      lastSeenAt: deps.clock.now().toISOString(),
    };
    await uow.sessions.update(updated);
    return stripTokenHash(updated);
  });
}

/**
 * Mark sessions whose last heartbeat is older than `timeoutMs` as
 * offline. Discovery status changes only; memberships are untouched.
 * Returns the sessions that transitioned.
 */
export async function expirePresence(
  deps: SessionDeps,
  timeoutMs: number = DEFAULT_PRESENCE_TIMEOUT_MS,
): Promise<Session[]> {
  return deps.db.write(async (uow) => {
    const now = deps.clock.now().getTime();
    const expired: Session[] = [];
    for (const stored of await uow.sessions.listAll()) {
      if (stored.status === "offline") continue;
      if (now - Date.parse(stored.lastSeenAt) <= timeoutMs) continue;
      const updated: StoredSession = { ...stored, status: "offline" };
      await uow.sessions.update(updated);
      expired.push(stripTokenHash(updated));
    }
    return expired;
  });
}
