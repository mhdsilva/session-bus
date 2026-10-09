import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomIdGenerator, systemClock } from "@session-bus/domain";
import { buildHubApp } from "@session-bus/hub";
import { openSqliteDatabase } from "@session-bus/sqlite";
import { type McpSession, startMcpSession } from "./mcp-session.js";

export interface TestSystem {
  readonly url: string;
  startMcpSession(name: string, harness: string): Promise<McpSession>;
  close(): Promise<void>;
}

export async function startTestSystem(
  options: { port?: number } = {},
): Promise<TestSystem> {
  const directory = await mkdtemp(join(tmpdir(), "session-bus-e2e-"));
  const db = openSqliteDatabase({ filename: join(directory, "hub.sqlite") });
  const config = {
    host: "127.0.0.1",
    port: options.port ?? 0,
    databasePath: join(directory, "hub.sqlite"),
    presenceTtlMs: 30_000,
  };
  const app = await buildHubApp({
    db,
    clock: systemClock,
    ids: randomIdGenerator,
    config,
  });
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    await app.close();
    await db[Symbol.asyncDispose]();
    await rm(directory, { recursive: true, force: true });
    throw new Error("Test hub did not bind a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}`;
  const sessions: McpSession[] = [];
  let closed = false;
  return {
    url,
    async startMcpSession(name, harness) {
      if (closed) throw new Error("Test system is already closed");
      const entry = fileURLToPath(
        new URL("../../../apps/mcp/dist/main.js", import.meta.url),
      );
      const session = await startMcpSession({
        name,
        harness,
        projectRoot: directory,
        hubUrl: url,
        executable: process.execPath,
        args: [entry],
      });
      sessions.push(session);
      return session;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        sessions
          .splice(0)
          .reverse()
          .map((session) => session.close()),
      );
      await app.close();
      await db[Symbol.asyncDispose]();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
