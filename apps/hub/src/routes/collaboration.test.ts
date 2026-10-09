import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomIdGenerator, systemClock } from "@session-bus/domain";
import { openSqliteDatabase } from "@session-bus/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildHubApp } from "../app.js";

const apps: Awaited<ReturnType<typeof buildHubApp>>[] = [];
const directories: string[] = [];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "session-bus-collab-"));
  directories.push(directory);
  const app = await buildHubApp({
    db: openSqliteDatabase({ filename: join(directory, "hub.sqlite") }),
    clock: systemClock,
    ids: randomIdGenerator,
    config: {
      host: "127.0.0.1",
      port: 7345,
      databasePath: join(directory, "hub.sqlite"),
      presenceTtlMs: 30_000,
    },
  });
  apps.push(app);
  const register = async (name: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: {
        name,
        harness: { name: "test", version: "1" },
        projectRoot: "/repo",
      },
    });
    return response.json() as {
      session: { id: string };
      instanceToken: string;
    };
  };
  const alice = await register("alice");
  const bob = await register("bob");
  const mallory = await register("mallory");
  const createRoom = await app.inject({
    method: "POST",
    url: "/api/v1/rooms",
    headers: {
      authorization: `Bearer ${alice.instanceToken}`,
      "idempotency-key": "room-1",
    },
    payload: { title: "Shared task", objective: "Implement the API" },
  });
  const room = createRoom.json().room as { id: string };
  const invite = await app.inject({
    method: "POST",
    url: `/api/v1/rooms/${room.id}/invitations`,
    headers: {
      authorization: `Bearer ${alice.instanceToken}`,
      "idempotency-key": "invite-1",
    },
    payload: { sessionIds: [bob.session.id] },
  });
  return { app, alice, bob, mallory, room, invite };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("collaboration HTTP API", () => {
  it("blocks a valid non-member token from reading room events", async () => {
    const { app, room, mallory } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${room.id}/events?after=0`,
      headers: { authorization: `Bearer ${mallory.instanceToken}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROOM_MEMBERSHIP_REQUIRED");
  });

  it("returns the same event when a message request is replayed", async () => {
    const { app, alice, room } = await fixture();
    const request = {
      method: "POST" as const,
      url: `/api/v1/rooms/${room.id}/messages`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "msg-1",
      },
      payload: { type: "message", text: "hello" },
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("only exposes context after an invitee accepts, and returns ordered events", async () => {
    const { app, alice, bob, room } = await fixture();
    const tokenHeader = { authorization: `Bearer ${bob.instanceToken}` };
    const preview = await app.inject({
      method: "GET",
      url: "/api/v1/invitations",
      headers: tokenHeader,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().items[0].room.id).toBe(room.id);
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${room.id}/context`,
      headers: tokenHeader,
    });
    expect(forbidden.statusCode).toBe(403);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/invitation`,
      headers: { ...tokenHeader, "idempotency-key": "accept-1" },
      payload: { accept: true },
    });
    expect(accepted.statusCode).toBe(200);
    const message = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/messages`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "msg-2",
      },
      payload: { text: "welcome" },
    });
    expect(message.statusCode).toBe(201);
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${room.id}/events?after=0&limit=200`,
      headers: { authorization: `Bearer ${bob.instanceToken}` },
    });
    expect(events.statusCode).toBe(200);
    expect(
      events.json().items.map((event: { type: string }) => event.type),
    ).toEqual(["member_invited", "member_joined", "message"]);
  });

  it("requires an idempotency key for every mutation", async () => {
    const { app, alice } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers: { authorization: `Bearer ${alice.instanceToken}` },
      payload: { title: "No key", objective: "Must fail" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("coordinates tasks and artifacts and records operator messages as a separate actor", async () => {
    const { app, alice, bob, room } = await fixture();
    await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/invitation`,
      headers: {
        authorization: `Bearer ${bob.instanceToken}`,
        "idempotency-key": "accept",
      },
      payload: { accept: true },
    });
    const taskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/tasks`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "task",
      },
      payload: {
        title: "Implement persistence",
        description: "Complete the adapter",
      },
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json().task as { id: string };
    const claimed = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/claim`,
      headers: {
        authorization: `Bearer ${bob.instanceToken}`,
        "idempotency-key": "claim",
      },
    });
    expect(claimed.statusCode).toBe(200);
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${task.id}`,
      headers: {
        authorization: `Bearer ${bob.instanceToken}`,
        "idempotency-key": "finish",
      },
      payload: { status: "completed", resultSummary: "Implemented" },
    });
    expect(updated.json().task.status).toBe("completed");
    const artifact = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/artifacts`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "artifact",
      },
      payload: {
        kind: "patch",
        uri: "/repo/change.patch",
        summary: "Proposed changes",
      },
    });
    expect(artifact.statusCode).toBe(201);

    const originHeaders = {
      host: "127.0.0.1:7345",
      origin: "http://127.0.0.1:7345",
    };
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/operator/bootstrap",
      headers: originHeaders,
    });
    const cookie = String(bootstrap.headers["set-cookie"]).split(";")[0];
    const humanMessage = await app.inject({
      method: "POST",
      url: `/api/v1/operator/rooms/${room.id}/messages`,
      headers: { ...originHeaders, cookie, "idempotency-key": "human-message" },
      payload: { text: "I reviewed the approach" },
    });
    expect(humanMessage.statusCode).toBe(201);
    expect(humanMessage.json().event.senderId).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    const operatorSessions = await app.inject({
      method: "GET",
      url: "/api/v1/operator/sessions",
      headers: { ...originHeaders, cookie },
    });
    expect(
      operatorSessions
        .json()
        .items.some(
          (item: { id: string }) =>
            item.id === humanMessage.json().event.senderId,
        ),
    ).toBe(false);

    const closed = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/close`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "close",
      },
      payload: { summary: "Done" },
    });
    expect(closed.statusCode).toBe(200);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/messages`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "after-close",
      },
      payload: { text: "Too late" },
    });
    expect(rejected.statusCode).toBe(410);
  });

  it("long-polls from room cursors and caps the timeout", async () => {
    const { app, alice, bob, room } = await fixture();
    const invited = await app.inject({
      method: "GET",
      url: `/api/v1/events/wait?timeoutMs=0`,
      headers: { authorization: `Bearer ${bob.instanceToken}` },
    });
    expect(
      invited.json().items.map((event: { type: string }) => event.type),
    ).toEqual(["member_invited"]);
    await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/invitation`,
      headers: {
        authorization: `Bearer ${bob.instanceToken}`,
        "idempotency-key": "accept",
      },
      payload: { accept: true },
    });
    const cursor = { [room.id]: 2 };
    const waiting = app.inject({
      method: "GET",
      url: `/api/v1/events/wait?timeoutMs=1000&afterByRoom=${encodeURIComponent(JSON.stringify(cursor))}`,
      headers: { authorization: `Bearer ${bob.instanceToken}` },
    });
    const message = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/messages`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "wait-message",
      },
      payload: { text: "wake up" },
    });
    expect(message.statusCode).toBe(201);
    expect(
      (await waiting).json().items.map((event: { type: string }) => event.type),
    ).toContain("message");
    const tooLong = await app.inject({
      method: "GET",
      url: "/api/v1/events/wait?timeoutMs=30001",
      headers: { authorization: `Bearer ${bob.instanceToken}` },
    });
    expect(tooLong.statusCode).toBe(400);
  });
});
