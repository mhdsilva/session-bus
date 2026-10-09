import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyEdit,
  entryEnvironment,
  parseJsonConfig,
  planJsonInstall,
  planJsonRemove,
  readJsonConfig,
} from "./json-config.js";
import {
  type HarnessIntegration,
  type InstallInput,
  validateLoopbackHubUrl,
} from "./types.js";

export function createOpenCodeIntegration(): HarnessIntegration {
  const configPath = (root: string) =>
    resolve(
      root,
      existsSync(resolve(root, "opencode.jsonc"))
        ? "opencode.jsonc"
        : "opencode.json",
    );
  return {
    name: "opencode",
    configPath,
    async detect(root) {
      const mcp = parseJsonConfig(await readJsonConfig(configPath(root))).mcp;
      return !!mcp && typeof mcp === "object" && "session-bus" in mcp;
    },
    async planInstall(input: InstallInput) {
      return planJsonInstall(configPath(input.projectRoot), "mcp", {
        type: "local",
        command: [process.execPath, input.executable],
        environment: {
          ...entryEnvironment(input, "opencode"),
          SESSION_BUS_URL: validateLoopbackHubUrl(input.hubUrl),
        },
        enabled: true,
      });
    },
    planRemove(root) {
      return planJsonRemove(configPath(root), "mcp");
    },
    apply: applyEdit,
  };
}
