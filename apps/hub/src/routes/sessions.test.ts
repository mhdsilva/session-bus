import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "@session-bus/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildHubApp } from "../app.js";
import { loadConfig } from "../config.js";

const apps: Awaited<ReturnType<typeof buildHubApp>>[] = [];
const directories: string[] = [];
let now = new Date("2026-10-09T12:00:00.000Z");
let nextId = 10;

async function hubFixture() {
  const directory = mkdtempSync(join(tmpdir(), "session-bus-hub-"));
  directories.push(directory);
  const app = await buildHubApp({
    db: openSqliteDatabase({ filename: join(directory, "hub.sqlite") }),
    clock: { now: () => new Date(now) },
    ids: {
      next: () =>
        `123e4567-e89b-42d3-a456-${String(nextId++).padStart(12, "0")}`,
    },
    config: {
      host: "127.0.0.1",
      port: 7345,
      databasePath: join(directory, "hub.sqlite"),
      presenceTtlMs: 30_000,
    },
  });
  apps.push(app);
  return app;
}

const validProfile = {
  name: "codex-session",
  harness: { name: "codex", version: "1.0.0" },
  projectRoot: "/work/session-bus",
  capabilities: ["typescript"],
  currentFocus: "API",
  metadata: {},
};

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  now = new Date("2026-10-09T12:00:00.000Z");
  nextId = 10;
});

describe("session HTTP API", () => {
  it("derives the current session from a bearer token and lists it without secrets", async () => {
    const app = await hubFixture();
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: validProfile,
    });
    expect(registered.statusCode).toBe(201);
    const { instanceToken, session } = registered.json();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${instanceToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].id).toBe(session.id);
    expect(JSON.stringify(response.json())).not.toContain("tokenHash");
    expect(JSON.stringify(response.json())).not.toContain("instanceToken");
  });

  it("rejects missing/invalid bearer tokens and forged session headers", async () => {
    const app = await hubFixture();
    for (const headers of [
      {},
      { authorization: "Bearer invalid" },
      { "x-session-id": "123e4567-e89b-42d3-a456-426614174001" },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("AUTHENTICATION_FAILED");
    }
  });

  it("validates registration and updates heartbeat and profile through authenticated routes", async () => {
    const app = await hubFixture();
    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { ...validProfile, projectRoot: "./relative" },
    });
    expect(malformed.statusCode).toBe(400);
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: validProfile,
    });
    const { instanceToken, session } = registered.json();
    const headers = { authorization: `Bearer ${instanceToken}` };
    const heartbeat = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/heartbeat",
      headers,
      payload: { status: "busy" },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json().session.status).toBe("busy");
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/sessions/me",
      headers,
      payload: { ...validProfile, name: "renamed", currentFocus: "review" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().session).toMatchObject({
      id: session.id,
      name: "renamed",
      currentFocus: "review",
      status: "busy",
    });
  });

  it("marks stale sessions offline in discovery", async () => {
    const app = await hubFixture();
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: validProfile,
    });
    const { instanceToken } = registered.json();
    now = new Date("2026-10-09T12:01:00.000Z");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${instanceToken}` },
    });
    expect(response.json().items[0].status).toBe("offline");
    const heartbeat = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/heartbeat",
      headers: { authorization: `Bearer ${instanceToken}` },
    });
    expect(heartbeat.json().session.status).toBe("available");
  });

  it("allows duplicate display names without conflating session identities", async () => {
    const app = await hubFixture();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: validProfile,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: {
        ...validProfile,
        harness: { name: "claude-code", version: "2.0.0" },
      },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().session.id).not.toBe(first.json().session.id);
    expect(second.json().instanceToken).not.toBe(first.json().instanceToken);
  });

  it("defaults to loopback and rejects a non-loopback listen host", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 7345,
      databasePath: ".session-bus/session-bus.sqlite",
      presenceTtlMs: 30_000,
    });
    expect(() => loadConfig({ SESSION_BUS_HOST: "0.0.0.0" })).toThrow(
      /loopback/,
    );
  });

  it("separates operator cookies from agent bearer auth and rejects cross-origin bootstrap", async () => {
    const app = await hubFixture();
    const crossOrigin = await app.inject({
      method: "GET",
      url: "/api/v1/operator/bootstrap",
      headers: { host: "127.0.0.1:7345", origin: "http://evil.example" },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const noCookie = await app.inject({
      method: "GET",
      url: "/api/v1/operator/sessions",
      headers: { host: "127.0.0.1:7345", origin: "http://127.0.0.1:7345" },
    });
    expect(noCookie.statusCode).toBe(401);
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/operator/bootstrap",
      headers: { host: "127.0.0.1:7345", origin: "http://127.0.0.1:7345" },
    });
    expect(bootstrap.statusCode).toBe(204);
    const cookie = bootstrap.headers["set-cookie"];
    const operatorRead = await app.inject({
      method: "GET",
      url: "/api/v1/operator/sessions",
      headers: {
        host: "127.0.0.1:7345",
        origin: "http://127.0.0.1:7345",
        cookie: String(cookie).split(";")[0],
      },
    });
    expect(operatorRead.statusCode).toBe(200);
    const agentCannotImpersonateOperator = await app.inject({
      method: "GET",
      url: "/api/v1/operator/sessions",
      headers: {
        host: "127.0.0.1:7345",
        origin: "http://127.0.0.1:7345",
        authorization: "Bearer arbitrary",
      },
    });
    expect(agentCannotImpersonateOperator.statusCode).toBe(401);
  });
});
