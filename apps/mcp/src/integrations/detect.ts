import { createClaudeCodeIntegration } from "./claude-code.js";
import { createCodexIntegration } from "./codex.js";
import { createOpenCodeIntegration } from "./opencode.js";
import type { Harness, HarnessIntegration } from "./types.js";

export const integrations: Record<Harness, HarnessIntegration> = {
  "claude-code": createClaudeCodeIntegration(),
  codex: createCodexIntegration(),
  opencode: createOpenCodeIntegration(),
};

export async function detectIntegrations(projectRoot: string) {
  const results = await Promise.all(
    Object.values(integrations).map(async (integration) => ({
      harness: integration.name,
      configured: await integration.detect(projectRoot),
      path: integration.configPath(projectRoot),
    })),
  );
  return results;
}
