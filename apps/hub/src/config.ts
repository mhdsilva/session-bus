import { isIP } from "node:net";
import { z } from "zod/v4";

const envSchema = z.object({
  SESSION_BUS_HOST: z.string().default("127.0.0.1"),
  SESSION_BUS_PORT: z.coerce.number().int().min(1).max(65535).default(7345),
  SESSION_BUS_DB: z.string().min(1).default(".session-bus/session-bus.sqlite"),
  SESSION_BUS_PRESENCE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),
});

export interface HubConfig {
  host: string;
  port: number;
  databasePath: string;
  presenceTtlMs: number;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost") return true;
  const ipVersion = isIP(normalized);
  return ipVersion === 4
    ? normalized.startsWith("127.")
    : ipVersion === 6 && normalized === "::1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsed = envSchema.parse(env);
  if (!isLoopbackHost(parsed.SESSION_BUS_HOST)) {
    throw new Error("SESSION_BUS_HOST must be a loopback address");
  }
  return {
    host: parsed.SESSION_BUS_HOST,
    port: parsed.SESSION_BUS_PORT,
    databasePath: parsed.SESSION_BUS_DB,
    presenceTtlMs: parsed.SESSION_BUS_PRESENCE_TTL_MS,
  };
}
