import {
  type Artifact,
  type ArtifactKind,
  artifactKindSchema,
  artifactSchema,
} from "@session-bus/protocol";
import { DomainError } from "./errors.js";
import {
  appendEvent,
  authenticateCaller,
  type CollaborationDeps,
  requireActiveMembership,
} from "./events.js";

/**
 * Artifact publication. The hub stores a validated reference only: it
 * never reads a project path or dereferences the URI, so an artifact is
 * always data and never authority.
 */

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export interface PublishArtifactInput {
  roomId: string;
  kind: string;
  uri: string;
  summary?: string;
  contentHash?: string;
  idempotencyKey: string;
}

interface PublishArtifactIdempotencyRecord {
  roomId: string;
  kind: ArtifactKind;
  uri: string;
  summary: string;
  contentHash?: string;
  artifact: Artifact;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isValidAbsoluteUri(value: string): boolean {
  if (!URI_SCHEME_PATTERN.test(value) || /\s/.test(value)) return false;
  if (/%(?![\da-f]{2})/i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateArtifactKind(kind: string): ArtifactKind {
  const parsed = artifactKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      `unknown artifact kind ${JSON.stringify(kind)}`,
    );
  }
  return parsed.data;
}

function validateArtifactUri(kind: ArtifactKind, uri: string): string {
  const trimmed = uri.trim();
  if (trimmed.length === 0 || trimmed.length > 4000) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "artifact uri must be a non-empty string of at most 4000 characters",
    );
  }
  const hasScheme = URI_SCHEME_PATTERN.test(trimmed);
  if (kind === "url") {
    if (!isValidAbsoluteUri(trimmed)) {
      throw new DomainError(
        "INVALID_PAYLOAD",
        "a url artifact must be a syntactically valid absolute URI",
      );
    }
    return trimmed;
  }
  if (
    (hasScheme && !isValidAbsoluteUri(trimmed)) ||
    (!hasScheme && !isAbsolutePath(trimmed))
  ) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "artifact uri must be a syntactically valid absolute URI or an absolute path",
    );
  }
  return trimmed;
}

export async function publishArtifact(
  deps: CollaborationDeps,
  authToken: string,
  input: PublishArtifactInput,
): Promise<Artifact> {
  const kind = validateArtifactKind(input.kind);
  const uri = validateArtifactUri(kind, input.uri);
  const summary = input.summary?.trim() ?? "";
  if (summary.length > 2000) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "artifact summary must be at most 2000 characters",
    );
  }
  const contentHash = input.contentHash?.trim() || undefined;
  if (contentHash !== undefined && contentHash.length > 256) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "artifact content hash must be at most 256 characters",
    );
  }
  return deps.db.write(async (uow) => {
    const caller = await authenticateCaller(uow, authToken);
    const room = await uow.rooms.findById(input.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${input.roomId} does not exist`,
      );
    }
    const key = `room:artifact:${room.id}:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as PublishArtifactIdempotencyRecord | null;
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.uri !== uri ||
        existing.summary !== summary ||
        existing.contentHash !== contentHash
      ) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used with a different artifact",
        );
      }
      return existing.artifact;
    }
    const membership = await uow.rooms.findMembership(room.id, caller.id);
    requireActiveMembership(membership, room, { requireOpen: true });
    const artifact = artifactSchema.parse({
      id: deps.ids.next(),
      roomId: room.id,
      publisherSessionId: caller.id,
      kind,
      uri,
      summary,
      contentHash,
      createdAt: deps.clock.now().toISOString(),
    });
    await uow.artifacts.insert(artifact);
    await appendEvent(deps, uow, {
      roomId: room.id,
      senderId: caller.id,
      type: "artifact_published",
      payload: { artifact },
    });
    await uow.idempotency.save(key, {
      roomId: room.id,
      kind,
      uri,
      summary,
      contentHash,
      artifact,
    } satisfies PublishArtifactIdempotencyRecord);
    return artifact;
  });
}
