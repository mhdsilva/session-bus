import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import { makeEdit } from "./json-config.js";
import {
  type ConfigEdit,
  type HarnessIntegration,
  type InstallInput,
  validateLoopbackHubUrl,
} from "./types.js";

function sectionBounds(
  text: string,
): { start: number; end: number } | undefined {
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  let start: number | undefined;
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.session-bus\]\s*(?:#.*)?(?:\r?\n)?$/.test(line))
      start = offset;
    else if (
      start !== undefined &&
      /^\s*\[/.test(line) &&
      !/^\s*\[mcp_servers\.session-bus(?:\.|\])/.test(line)
    )
      return { start, end: offset };
    offset += line.length;
  }
  return start === undefined ? undefined : { start, end: text.length };
}

async function readToml(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function managed(text: string | undefined): boolean {
  if (!text) return false;
  const parsed = parse(text) as Record<string, unknown>;
  const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
  const entry = servers?.["session-bus"] as Record<string, unknown> | undefined;
  const env = entry?.env as Record<string, unknown> | undefined;
  return env?.SESSION_BUS_MANAGED === "true";
}

function edit(
  targetPath: string,
  beforeText: string | undefined,
  afterText: string | undefined,
): ConfigEdit {
  return makeEdit(targetPath, beforeText, afterText);
}

async function apply(editValue: ConfigEdit): Promise<string | undefined> {
  if (editValue.beforeText === editValue.afterText) return undefined;
  await mkdir(dirname(editValue.targetPath), { recursive: true });
  let backup: string | undefined;
  let mode = 0o600;
  let actual: string | undefined;
  try {
    const status = await lstat(editValue.targetPath);
    if (!status.isFile())
      throw new Error(
        `Refusing to update a non-regular config file: ${editValue.targetPath}`,
      );
    mode = status.mode & 0o777;
    actual = await readFile(editValue.targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (actual !== editValue.beforeText)
    throw new Error(
      `Configuration changed after preview; run install again: ${editValue.targetPath}`,
    );
  if (editValue.beforeText !== undefined) {
    backup = `${editValue.targetPath}.session-bus.bak-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    await copyFile(editValue.targetPath, backup);
  }
  if (editValue.afterText === undefined) {
    const { unlink } = await import("node:fs/promises");
    await unlink(editValue.targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return backup;
  }
  const tempPath = `${editValue.targetPath}.session-bus.tmp-${process.pid}`;
  await writeFile(tempPath, editValue.afterText, { mode });
  await rename(tempPath, editValue.targetPath);
  return backup;
}

export function createCodexIntegration(): HarnessIntegration {
  const configPath = (root: string) => resolve(root, ".codex", "config.toml");
  return {
    name: "codex",
    configPath,
    async detect(root) {
      const text = await readToml(configPath(root));
      if (!text) return false;
      const parsed = parse(text) as Record<string, unknown>;
      const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
      return !!servers && "session-bus" in servers;
    },
    async planInstall(input: InstallInput) {
      const targetPath = configPath(input.projectRoot);
      const beforeText = await readToml(targetPath);
      const text = beforeText ?? "";
      const parsed = text ? (parse(text) as Record<string, unknown>) : {};
      const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
      const current = servers?.["session-bus"] as
        | Record<string, unknown>
        | undefined;
      if (current && !managed(text))
        throw new Error(
          "Refusing to overwrite an existing mcp_servers.session-bus entry",
        );
      const bounds = sectionBounds(text);
      const env = Object.entries({
        SESSION_BUS_URL: validateLoopbackHubUrl(input.hubUrl),
        SESSION_BUS_PROJECT_ROOT: input.projectRoot,
        SESSION_BUS_SESSION_NAME: `codex-${input.projectRoot.split("/").filter(Boolean).at(-1) ?? "project"}`,
        SESSION_BUS_HARNESS: "codex",
        SESSION_BUS_HARNESS_VERSION: "unknown",
        SESSION_BUS_CAPABILITIES: "collaboration,context-sharing",
        SESSION_BUS_CURRENT_FOCUS: "",
        SESSION_BUS_MANAGED: "true",
      })
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join("\n");
      const block = `\n[mcp_servers.session-bus]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(input.executable)}]\n\n[mcp_servers.session-bus.env]\n${env}\n`;
      const afterText = bounds
        ? `${text.slice(0, bounds.start)}${block.trimStart()}${text.slice(bounds.end)}`
        : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${block}`;
      parse(afterText);
      const preview = `--- ${targetPath} (${current ? "replace managed" : "add"} mcp_servers.session-bus)\n+++ planned change\n${block
        .trim()
        .split("\n")
        .map((line) => `+ ${line}`)
        .join("\n")}`;
      return { ...edit(targetPath, beforeText, afterText), preview };
    },
    async planRemove(root) {
      const targetPath = configPath(root);
      const beforeText = await readToml(targetPath);
      if (!beforeText) return edit(targetPath, undefined, undefined);
      const bounds = sectionBounds(beforeText);
      if (!bounds)
        return {
          ...edit(targetPath, beforeText, beforeText),
          preview: `--- ${targetPath}\n+++ planned change\n(no managed session-bus entry)`,
        };
      if (!managed(beforeText))
        throw new Error(
          "Refusing to remove an unmanaged mcp_servers.session-bus entry",
        );
      let afterText = `${beforeText.slice(0, bounds.start)}${beforeText.slice(bounds.end)}`;
      if (!afterText.trim()) afterText = undefined as unknown as string;
      else parse(afterText);
      return {
        ...edit(targetPath, beforeText, afterText),
        preview: `--- ${targetPath}\n+++ planned change\n- remove managed mcp_servers.session-bus table`,
      };
    },
    apply,
  };
}
