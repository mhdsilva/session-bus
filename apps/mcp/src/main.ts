#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readConfig } from "./config.js";
import { HttpHubClient } from "./hub-client.js";
import { startSession } from "./session.js";
import { buildMcpServer } from "./tools.js";

async function main() {
  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig();
  } catch (error) {
    console.error("session-bus configuration error:", error);
    process.exitCode = 1;
    return;
  }
  const hub = new HttpHubClient(config.hubUrl);
  let shutdown = async () => {};
  let handle: ReturnType<typeof serveStdio> | undefined;
  try {
    shutdown = await startSession(hub, config.profile);
    const server = await buildMcpServer({ hub, profile: config.profile });
    handle = serveStdio(() => server, {
      onerror: (error) =>
        console.error("session-bus MCP transport error", error),
    });
    const close = () => {
      void (async () => {
        await handle?.close();
        await shutdown();
      })();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    process.stdin.once("end", close);
  } catch (error) {
    console.error("session-bus startup failed:", error);
    await shutdown();
    process.exitCode = 1;
  }
}
void main();
