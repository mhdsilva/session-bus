import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomIdGenerator, systemClock } from "@session-bus/domain";
import { openSqliteDatabase } from "@session-bus/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildHubApp } from "../app.js";
import { EventBroker, SlowConsumerError } from "./event-broker.js";
import { WebSocketTicketStore } from "./websocket.js";

const apps: Awaited<ReturnType<typeof buildHubApp>>[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "session-bus-ws-"));
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
  const roomResponse = await app.inject({
    method: "POST",
    url: "/api/v1/rooms",
    headers: {
      authorization: `Bearer ${alice.instanceToken}`,
      "idempotency-key": "room",
    },
    payload: { title: "Realtime", objective: "Test the stream" },
  });
  const room = roomResponse.json().room as { id: string };
  await app.inject({
    method: "POST",
    url: `/api/v1/rooms/${room.id}/invitations`,
    headers: {
      authorization: `Bearer ${alice.instanceToken}`,
      "idempotency-key": "invite",
    },
    payload: { sessionIds: [bob.session.id] },
  });
  return { app, alice, bob, room };
}

function connect(url: string): WebSocket {
  const socket = new WebSocket(url);
  sockets.push(socket);
  return socket;
}

const frameQueues = new WeakMap<
  WebSocket,
  {
    frames: Array<Record<string, unknown>>;
    waiters: Array<{
      resolve: (frame: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }>;
  }
>();

function nextFrame(
  socket: WebSocket,
  label = "",
): Promise<Record<string, unknown>> {
  let state = frameQueues.get(socket);
  if (!state) {
    state = { frames: [], waiters: [] };
    frameQueues.set(socket, state);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = state?.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else state?.frames.push(frame);
    });
    socket.on("error", (error) => {
      for (const waiter of state?.waiters.splice(0) ?? []) waiter.reject(error);
    });
    socket.on("close", (code, reason) => {
      const error = new Error(
        `socket closed before frame (${code}: ${reason.toString()})`,
      );
      for (const waiter of state?.waiters.splice(0) ?? []) waiter.reject(error);
    });
  }
  const saved = state.frames.shift();
  if (saved) return Promise.resolve(saved);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state?.waiters.splice(state.waiters.indexOf(waiter), 1);
      reject(new Error(`timed out waiting for WebSocket frame ${label}`));
    }, 1_000);
    const waiter = {
      resolve: (frame: Record<string, unknown>) => {
        clearTimeout(timeout);
        resolve(frame);
      },
      reject: (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      },
    };
    state?.waiters.push(waiter);
  });
}

async function openSocket(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("event broker", () => {
  const event = (
    id: string,
    type: "message" | "member_invited" | "member_joined" = "message",
    sessionId?: string,
  ) => ({
    id: `123e4567-e89b-42d3-a456-${id.padStart(12, "0")}`,
    roomId: "123e4567-e89b-42d3-a456-426614174000",
    sequence: Number(id),
    senderId: "123e4567-e89b-42d3-a456-426614174001",
    type,
    version: 1 as const,
    payload: sessionId ? { sessionId } : { text: id },
    createdAt: "2026-10-09T12:00:00.000Z",
  });

  it("delivers targeted invitations and closes a full slow-consumer queue", async () => {
    const broker = new EventBroker();
    const sessionId = "123e4567-e89b-42d3-a456-426614174001";
    const subscription = broker.subscribe({
      sessionId,
      roomIds: [],
      queueLimit: 1,
    });
    broker.publish(event("1", "member_invited", sessionId));
    broker.publish(event("2", "member_joined", sessionId));
    await expect(subscription.next()).rejects.toBeInstanceOf(SlowConsumerError);
  });

  it("issues single-use expiring WebSocket tickets", () => {
    const tickets = new WebSocketTicketStore(1000);
    const { ticket } = tickets.issue("session", 0);
    expect(tickets.consume(ticket, 999)).toBe("session");
    expect(tickets.consume(ticket, 999)).toBeNull();
    const expired = tickets.issue("session", 0).ticket;
    expect(tickets.consume(expired, 1000)).toBeNull();
  });
});

describe("authenticated WebSocket event stream", () => {
  it("streams all rooms to the local operator using a cookie-issued ticket", async () => {
    const { app, alice, room } = await fixture();
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/operator/ws-tickets",
      headers: { host: "127.0.0.1:7345", origin: "http://127.0.0.1:7345" },
    });
    expect(denied.statusCode).toBe(401);

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/operator/bootstrap",
      headers: { host: "127.0.0.1:7345", origin: "http://127.0.0.1:7345" },
    });
    const cookie = bootstrap.headers["set-cookie"] as string;
    const ticketResponse = await app.inject({
      method: "POST",
      url: "/api/v1/operator/ws-tickets",
      headers: {
        cookie,
        host: "127.0.0.1:7345",
        origin: "http://127.0.0.1:7345",
      },
    });
    expect(ticketResponse.statusCode).toBe(200);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("expected TCP listener");
    const socket = connect(`ws://127.0.0.1:${address.port}/api/v1/ws`);
    await openSocket(socket);
    socket.send(
      JSON.stringify({
        type: "subscribe",
        ticket: ticketResponse.json().ticket,
        afterByRoom: {},
      }),
    );
    expect((await nextFrame(socket, "operator backlog")).event).toMatchObject({
      type: "member_invited",
    });
    expect(await nextFrame(socket, "operator ready")).toMatchObject({
      type: "ready",
    });
    const message = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/messages`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "operator-live-message",
      },
      payload: { text: "Visible to the operator" },
    });
    expect(message.statusCode).toBe(201);
    expect(
      (await nextFrame(socket, "operator live message")).event,
    ).toMatchObject({
      payload: { text: "Visible to the operator" },
    });
  }, 15_000);

  it("delivers backlog then live events, and resumes from a room cursor", async () => {
    const { app, alice, bob, room } = await fixture();
    const ticketResponse = await app.inject({
      method: "POST",
      url: "/api/v1/ws-tickets",
      headers: { authorization: `Bearer ${bob.instanceToken}` },
    });
    expect(ticketResponse.statusCode).toBe(200);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("expected TCP listener");
    const socket = connect(`ws://127.0.0.1:${address.port}/api/v1/ws`);
    await openSocket(socket);
    socket.send(
      JSON.stringify({
        type: "subscribe",
        ticket: ticketResponse.json().ticket,
        afterByRoom: {},
      }),
    );
    const invited = await nextFrame(socket);
    expect((invited.event as { type: string }).type).toBe("member_invited");
    expect(await nextFrame(socket)).toMatchObject({ type: "ready" });

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/invitation`,
      headers: {
        authorization: `Bearer ${bob.instanceToken}`,
        "idempotency-key": "accept",
      },
      payload: { accept: true },
    });
    expect(accept.statusCode).toBe(200);
    expect((await nextFrame(socket)).event).toMatchObject({
      type: "member_joined",
    });
    const message = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/messages`,
      headers: {
        authorization: `Bearer ${alice.instanceToken}`,
        "idempotency-key": "message",
      },
      payload: { text: "live" },
    });
    expect(message.statusCode).toBe(201);
    expect((await nextFrame(socket)).event).toMatchObject({
      type: "message",
      sequence: 3,
    });
    socket.close();

    const reconnectTicket = await app.inject({
      method: "POST",
      url: "/api/v1/ws-tickets",
      headers: { authorization: `Bearer ${bob.instanceToken}` },
    });
    const reconnect = connect(`ws://127.0.0.1:${address.port}/api/v1/ws`);
    await openSocket(reconnect);
    reconnect.send(
      JSON.stringify({
        type: "subscribe",
        ticket: reconnectTicket.json().ticket,
        afterByRoom: { [room.id]: 2 },
      }),
    );
    expect((await nextFrame(reconnect)).event).toMatchObject({
      type: "message",
      sequence: 3,
    });
    expect(await nextFrame(reconnect)).toMatchObject({ type: "ready" });
  });

  it("rejects an invalid ticket without accepting an instance token in the URL", async () => {
    const { app } = await fixture();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("expected TCP listener");
    const socket = connect(`ws://127.0.0.1:${address.port}/api/v1/ws`);
    await openSocket(socket);
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    socket.send(
      JSON.stringify({
        type: "subscribe",
        ticket: "not-a-ticket",
        afterByRoom: {},
      }),
    );
    await expect(closed).resolves.toBe(1008);
  });
});
