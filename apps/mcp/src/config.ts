import { isAbsolute } from "node:path";
import { absolutePathSchema } from "@session-bus/protocol";

export interface BridgeConfig {
  hubUrl: string;
  profile: {
    name: string;
    harness: { name: string; version: string };
    projectRoot: string;
    capabilities: string[];
    currentFocus: string;
    metadata: Record<string, unknown>;
  };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const projectRoot = env.SESSION_BUS_PROJECT_ROOT ?? process.cwd();
  if (!isAbsolute(projectRoot))
    throw new Error("SESSION_BUS_PROJECT_ROOT must be an absolute path");
  absolutePathSchema.parse(projectRoot);
  const hubUrl = new URL(env.SESSION_BUS_URL ?? "http://127.0.0.1:7345");
  if (hubUrl.protocol !== "http:" && hubUrl.protocol !== "https:")
    throw new Error("SESSION_BUS_URL must use http or https");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hubUrl.hostname))
    throw new Error("SESSION_BUS_URL must point to a loopback host");
  return {
    hubUrl: hubUrl.toString().replace(/\/$/, ""),
    profile: {
      name:
        env.SESSION_BUS_SESSION_NAME ??
        `${env.SESSION_BUS_HARNESS ?? "agent"}-${process.pid}`,
      harness: {
        name: env.SESSION_BUS_HARNESS ?? "unknown",
        version: env.SESSION_BUS_HARNESS_VERSION ?? "unknown",
      },
      projectRoot,
      capabilities: (env.SESSION_BUS_CAPABILITIES ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      currentFocus: "",
      metadata: {},
    },
  };
}
