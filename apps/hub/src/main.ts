import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomIdGenerator, systemClock } from "@session-bus/domain";
import { openSqliteDatabase } from "@session-bus/sqlite";
import { buildHubApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
await mkdir(dirname(config.databasePath), { recursive: true });
const db = openSqliteDatabase({ filename: config.databasePath });
const app = await buildHubApp({
  db,
  clock: systemClock,
  ids: randomIdGenerator,
  config,
});
await app.listen({ host: config.host, port: config.port });

const shutdown = async () => {
  await app.close();
  await db[Symbol.asyncDispose]();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
