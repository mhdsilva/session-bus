import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "./index.js";

const session = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "Builder",
  harness: { name: "opencode", version: "1" },
  projectRoot: "/repo",
  capabilities: ["typescript"],
  currentFocus: "SQLite adapter",
  metadata: { nested: { ok: true } },
  status: "available" as const,
  lastSeenAt: "2026-10-09T12:00:00.000Z",
  tokenHash: "sha256:abc",
};

describe("SQLite persistence", () => {
  it("migrates idempotently and round-trips validated values", async () => {
    const db = openSqliteDatabase({ filename: ":memory:" });
    try {
      await db.migrate();
      await db.migrate();
      await db.write((uow) => uow.sessions.insert(session));
      await expect(
        db.read((uow) => uow.sessions.findById(session.id)),
      ).resolves.toEqual(session);
      await expect(
        db.read((uow) => uow.sessions.findByTokenHash(session.tokenHash)),
      ).resolves.toEqual(session);
    } finally {
      await db[Symbol.asyncDispose]();
    }
  });

  it("rolls back every mutation when a write callback throws", async () => {
    const db = openSqliteDatabase({ filename: ":memory:" });
    try {
      await expect(
        db.write(async (uow) => {
          await uow.sessions.insert(session);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      await expect(
        db.read((uow) => uow.sessions.findById(session.id)),
      ).resolves.toBeNull();
    } finally {
      await db[Symbol.asyncDispose]();
    }
  });

  it("reports malformed persisted DTOs as typed persistence errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "session-bus-sqlite-"));
    const filename = join(directory, "test.db");
    const db = openSqliteDatabase({ filename });
    try {
      await db.write((uow) => uow.sessions.insert(session));
    } finally {
      await db[Symbol.asyncDispose]();
    }
    try {
      const raw = new BetterSqlite3(filename);
      raw
        .prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?")
        .run("{", session.id);
      raw.close();
      const reopened = openSqliteDatabase({ filename });
      await expect(
        reopened.read((uow) => uow.sessions.findById(session.id)),
      ).rejects.toMatchObject({ name: "PersistenceError" });
      await reopened[Symbol.asyncDispose]();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("round-trips collaboration rows and reads events in cursor order", async () => {
    const db = openSqliteDatabase({ filename: ":memory:" });
    const room = {
      id: "123e4567-e89b-42d3-a456-426614174001",
      title: "Planning",
      objective: "Coordinate implementation",
      status: "open" as const,
      createdBy: session.id,
      createdAt: session.lastSeenAt,
      contextSummary: "Initial context",
    };
    const membership = {
      roomId: room.id,
      sessionId: session.id,
      state: "active" as const,
      role: "owner",
      joinedAt: room.createdAt,
      lastReadSequence: 0,
    };
    const task = {
      id: "123e4567-e89b-42d3-a456-426614174002",
      roomId: room.id,
      title: "Persist state",
      description: "Add SQLite repositories",
      status: "open" as const,
      createdAt: room.createdAt,
      updatedAt: room.createdAt,
    };
    const artifact = {
      id: "123e4567-e89b-42d3-a456-426614174003",
      roomId: room.id,
      publisherSessionId: session.id,
      kind: "patch" as const,
      uri: "file:///tmp/patch.diff",
      summary: "Initial patch",
      createdAt: room.createdAt,
    };
    try {
      await db.write(async (uow) => {
        await uow.sessions.insert(session);
        await uow.rooms.insert(room);
        await uow.rooms.saveMembership(membership);
        const sequence = await uow.events.nextSequence(room.id);
        await uow.events.insert({
          id: "123e4567-e89b-42d3-a456-426614174004",
          roomId: room.id,
          sequence,
          senderId: session.id,
          type: "message",
          version: 1,
          payload: { z: 2, a: { y: true, b: 1 } },
          createdAt: room.createdAt,
        });
        await uow.tasks.insert(task);
        await uow.artifacts.insert(artifact);
        await uow.idempotency.save("replay-key", {
          eventId: "event",
          ok: true,
        });
      });
      const data = await db.read(async (uow) => ({
        membership: await uow.rooms.findMembership(room.id, session.id),
        event: (await uow.events.listAfter(room.id, 0, 10))[0],
        beyondCursor: await uow.events.listAfter(room.id, 1),
        task: await uow.tasks.findById(task.id),
        artifacts: await uow.artifacts.listByRoom(room.id),
        replay: await uow.idempotency.find("replay-key"),
      }));
      expect(data.membership).toEqual(membership);
      expect(data.event?.payload).toEqual({ z: 2, a: { y: true, b: 1 } });
      expect(data.beyondCursor).toEqual([]);
      expect(data.task).toEqual(task);
      expect(data.artifacts).toEqual([artifact]);
      expect(data.replay).toEqual({ eventId: "event", ok: true });
    } finally {
      await db[Symbol.asyncDispose]();
    }
  });
});
