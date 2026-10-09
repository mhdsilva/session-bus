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

export function createClaudeCodeIntegration(): HarnessIntegration {
  const configPath = (root: string) => resolve(root, ".mcp.json");
  return {
    name: "claude-code",
    configPath,
    async detect(root) {
      const text = await readJsonConfig(configPath(root));
      const servers = parseJsonConfig(text).mcpServers;
      return (
        !!servers && typeof servers === "object" && "session-bus" in servers
      );
    },
    async planInstall(input: InstallInput) {
      return planJsonInstall(configPath(input.projectRoot), "mcpServers", {
        command: process.execPath,
        args: [input.executable],
        env: {
          ...entryEnvironment(input, "claude-code"),
          SESSION_BUS_URL: validateLoopbackHubUrl(input.hubUrl),
        },
      });
    },
    planRemove(root) {
      return planJsonRemove(configPath(root), "mcpServers");
    },
    apply: applyEdit,
  };
}
