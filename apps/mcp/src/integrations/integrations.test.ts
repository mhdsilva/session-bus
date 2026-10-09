import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { integrations } from "./detect.js";
import type { Harness } from "./types.js";

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), "session bus project "));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const installInput = (projectRoot: string) => ({
  executable: "/opt/session bus/bin/session-bus-mcp",
  projectRoot,
  hubUrl: "http://127.0.0.1:7345",
});

describe.each(Object.keys(integrations) as Harness[])(
  "%s integration",
  (harness) => {
    const integration = integrations[harness];

    it("renders an absolute project-scoped MCP entry and preserves unrelated settings", async () => {
      const root = await project();
      const path = integration.configPath(root);
      await mkdir(join(root, ".codex"), { recursive: true });
      const original =
        harness === "claude-code"
          ? '{\n  "custom": true,\n  "mcpServers": {}\n}\n'
          : harness === "opencode"
            ? '{\n  // keep comment\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {}\n}\n'
            : 'model = "gpt-5"\n\n[features]\nfast_mode = true\n';
      if (harness !== "codex") await writeFile(path, original);
      else await writeFile(path, original);
      const edit = await integration.planInstall(installInput(root));
      expect(edit.preview).toContain("/opt/session bus/bin/session-bus-mcp");
      expect(edit.scope).toBe("project");
      const backup = await integration.apply(edit);
      expect(backup).toBeTruthy();
      const result = await readFile(path, "utf8");
      expect(result).toContain("session-bus");
      if (harness === "claude-code") expect(result).toContain('"custom": true');
      if (harness === "opencode") expect(result).toContain("// keep comment");
      if (harness === "codex") expect(result).toContain('model = "gpt-5"');
      expect(await integration.detect(root)).toBe(true);
    });

    it("backs up before apply and removes only its managed entry", async () => {
      const root = await project();
      const path = integration.configPath(root);
      const original =
        harness === "codex"
          ? 'model = "gpt-5"\n'
          : '{\n  "keep": {"value": 1}\n}\n';
      if (harness === "codex")
        await mkdir(join(root, ".codex"), { recursive: true });
      await writeFile(path, original);
      const edit = await integration.planInstall(installInput(root));
      const backup = await integration.apply(edit);
      expect(backup).toBeTruthy();
      if (!backup) throw new Error("Expected a configuration backup");
      expect(await readFile(backup, "utf8")).toBe(original);
      const removal = await integration.planRemove(root);
      await integration.apply(removal);
      const result = await readFile(path, "utf8");
      expect(result).toContain(
        harness === "codex" ? 'model = "gpt-5"' : '"keep"',
      );
      expect(await integration.detect(root)).toBe(false);
    });

    it("refuses to overwrite an existing unowned entry", async () => {
      const root = await project();
      const path = integration.configPath(root);
      if (harness === "codex") {
        await mkdir(join(root, ".codex"), { recursive: true });
        await writeFile(path, '[mcp_servers.session-bus]\ncommand = "other"\n');
      } else {
        const key = harness === "claude-code" ? "mcpServers" : "mcp";
        await writeFile(
          path,
          JSON.stringify({ [key]: { "session-bus": { command: "other" } } }),
        );
      }
      await expect(integration.planInstall(installInput(root))).rejects.toThrow(
        /Refusing to overwrite/,
      );
    });

    it("rejects a non-loopback hub URL", async () => {
      const root = await project();
      await expect(
        integration.planInstall({
          ...installInput(root),
          hubUrl: "https://example.com",
        }),
      ).rejects.toThrow(/loopback/);
    });

    it("does not overwrite configuration changed after the preview", async () => {
      const root = await project();
      const path = integration.configPath(root);
      if (harness === "codex")
        await mkdir(join(root, ".codex"), { recursive: true });
      await writeFile(
        path,
        harness === "codex" ? 'model = "gpt-5"\n' : '{\n  "keep": true\n}\n',
      );
      const edit = await integration.planInstall(installInput(root));
      const changed = `${edit.beforeText}\n// changed after preview\n`;
      await writeFile(path, changed);
      await expect(integration.apply(edit)).rejects.toThrow(
        /changed after preview/,
      );
      expect(await readFile(path, "utf8")).toBe(changed);
    });
  },
);

it("selects OpenCode JSONC when that project config already exists", async () => {
  const root = await project();
  await writeFile(join(root, "opencode.jsonc"), "{ // existing config\n}\n");
  expect(integrations.opencode.configPath(root)).toBe(
    join(root, "opencode.jsonc"),
  );
});
