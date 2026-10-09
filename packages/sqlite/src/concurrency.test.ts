import {
  closeRoom,
  createRoom,
  randomIdGenerator,
  registerSession,
  sendMessage,
  systemClock,
} from "@session-bus/domain";
import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "./index.js";

const room = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  title: "Race room",
  objective: "Test event ordering",
  status: "open" as const,
  createdBy: "123e4567-e89b-42d3-a456-426614174001",
  createdAt: "2026-10-09T12:00:00.000Z",
  contextSummary: "",
};

describe("SQLite transaction serialization", () => {
  it("allocates contiguous event sequences for concurrent writes", async () => {
    const db = openSqliteDatabase({ filename: ":memory:" });
    try {
      await db.write(async (uow) => {
        await uow.sessions.insert({
          id: room.createdBy,
          name: "Builder",
          harness: { name: "opencode", version: "1" },
          projectRoot: "/repo",
          capabilities: [],
          currentFocus: "",
          metadata: {},
          status: "available",
          lastSeenAt: room.createdAt,
          tokenHash: "sha256:creator",
        });
        await uow.rooms.insert(room);
      });
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          db.write(async (uow) => {
            const sequence = await uow.events.nextSequence(room.id);
            await new Promise((resolve) => setTimeout(resolve, index % 3));
            await uow.events.insert({
              id: `123e4567-e89b-42d3-a456-${String(index + 2).padStart(12, "0")}`,
              roomId: room.id,
              sequence,
              senderId: room.createdBy,
              type: "message",
              version: 1,
              payload: { text: `message ${index}` },
              createdAt: "2026-10-09T12:00:00.000Z",
            });
          }),
        ),
      );
      const events = await db.read((uow) => uow.events.listByRoom(room.id));
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
    } finally {
      await db[Symbol.asyncDispose]();
    }
  });

  it("never commits a message after the room_closed event in a close/send race", async () => {
    const db = openSqliteDatabase({ filename: ":memory:" });
    const deps = { db, clock: systemClock, ids: randomIdGenerator };
    try {
      const registered = await registerSession(
        { ...deps, generateToken: () => "race-token" },
        {
          name: "Closer",
          harness: { name: "codex", version: "1" },
          projectRoot: "/repo",
          capabilities: [],
          currentFocus: "",
          metadata: {},
        },
      );
      const created = await createRoom(deps, registered.token, {
        title: "Race",
        objective: "Close and send concurrently",
        idempotencyKey: "create",
      });
      const outcomes = await Promise.allSettled([
        closeRoom(deps, registered.token, {
          roomId: created.id,
          summary: "Done",
          idempotencyKey: "close",
        }),
        sendMessage(deps, registered.token, {
          roomId: created.id,
          text: "Concurrent message",
          idempotencyKey: "message",
        }),
      ]);
      expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(
        true,
      );
      const events = await db.read((uow) => uow.events.listByRoom(created.id));
      const closedAt = events.findIndex(
        (event) => event.type === "room_closed",
      );
      expect(closedAt).toBeGreaterThanOrEqual(0);
      expect(
        events.slice(closedAt + 1).some((event) => event.type === "message"),
      ).toBe(false);
      const room = await db.read((uow) => uow.rooms.findById(created.id));
      expect(room?.status).toBe("closed");
    } finally {
      await db[Symbol.asyncDispose]();
    }
  });

  it("replays a persisted idempotency key without appending another event", async () => {
    const db = openSqliteDatabase({ filename: ":memory:" });
    const deps = { db, clock: systemClock, ids: randomIdGenerator };
    try {
      const registered = await registerSession(
        { ...deps, generateToken: () => "replay-token" },
        {
          name: "Builder",
          harness: { name: "opencode", version: "1" },
          projectRoot: "/repo",
          capabilities: [],
          currentFocus: "",
          metadata: {},
        },
      );
      const room = await createRoom(deps, registered.token, {
        title: "Replay",
        objective: "Persist idempotency",
        idempotencyKey: "create",
      });
      const input = {
        roomId: room.id,
        text: "Only once",
        idempotencyKey: "send-once",
      };
      const first = await sendMessage(deps, registered.token, input);
      const replay = await sendMessage(deps, registered.token, input);
      expect(replay).toEqual(first);
      await expect(
        db.read((uow) => uow.events.listByRoom(room.id)),
      ).resolves.toHaveLength(1);
    } finally {
      await db[Symbol.asyncDispose]();
    }
  });
});
