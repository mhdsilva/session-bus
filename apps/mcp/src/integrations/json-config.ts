import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import type { ConfigEdit, InstallInput } from "./types.js";

export const MANAGED = "SESSION_BUS_MANAGED";

function isManagedEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const env = entry.env ?? entry.environment;
  return (
    !!env &&
    typeof env === "object" &&
    (env as Record<string, unknown>)[MANAGED] === "true"
  );
}

export async function readJsonConfig(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function parseJsonConfig(
  text: string | undefined,
): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  const errors: { error: number; offset: number; length: number }[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length) {
    const error = errors[0];
    if (!error) throw new Error("Could not parse JSON configuration");
    throw new Error(
      `Invalid JSON configuration at offset ${error.offset}: ${printParseErrorCode(error.error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration root must be an object");
  return value as Record<string, unknown>;
}

export async function planJsonInstall(
  targetPath: string,
  rootKey: string,
  entry: Record<string, unknown>,
): Promise<ConfigEdit> {
  const beforeText = await readJsonConfig(targetPath);
  const config = parseJsonConfig(beforeText);
  const servers = config[rootKey];
  if (
    servers !== undefined &&
    (!servers || typeof servers !== "object" || Array.isArray(servers))
  )
    throw new Error(`${rootKey} must be an object`);
  const current = (servers as Record<string, unknown> | undefined)?.[
    "session-bus"
  ];
  if (current !== undefined && !isManagedEntry(current))
    throw new Error(
      `Refusing to overwrite an existing ${rootKey}.session-bus entry`,
    );
  const envKey = "environment" in entry ? "environment" : "env";
  const markedEntry = {
    ...entry,
    [envKey]: {
      ...(entry[envKey] as Record<string, string>),
      [MANAGED]: "true",
    },
  };
  const afterText = applyEdits(
    beforeText ?? "{}\n",
    modify(beforeText ?? "{}\n", [rootKey, "session-bus"], markedEntry, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
  const action = current === undefined ? "add" : "replace managed";
  const entryText = JSON.stringify(markedEntry, null, 2)
    .split("\n")
    .map((line) => `+ ${line}`)
    .join("\n");
  return makeEdit(
    targetPath,
    beforeText,
    afterText,
    `--- ${targetPath} (${action} ${rootKey}.session-bus)\n+++ planned change\n${entryText}`,
  );
}

export async function planJsonRemove(
  targetPath: string,
  rootKey: string,
): Promise<ConfigEdit> {
  const beforeText = await readJsonConfig(targetPath);
  if (beforeText === undefined)
    return makeEdit(targetPath, undefined, undefined);
  const config = parseJsonConfig(beforeText);
  const servers = config[rootKey];
  const current =
    servers && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)["session-bus"]
      : undefined;
  if (current === undefined)
    return makeEdit(
      targetPath,
      beforeText,
      beforeText,
      `--- ${targetPath}\n+++ planned change\n(no managed session-bus entry)`,
    );
  if (!isManagedEntry(current))
    throw new Error(
      `Refusing to remove an unmanaged ${rootKey}.session-bus entry`,
    );
  const afterText = applyEdits(
    beforeText,
    modify(beforeText, [rootKey, "session-bus"], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
  return makeEdit(
    targetPath,
    beforeText,
    afterText,
    `--- ${targetPath}\n+++ planned change\n- remove managed ${rootKey}.session-bus entry`,
  );
}

export function makeEdit(
  targetPath: string,
  beforeText: string | undefined,
  afterText: string | undefined,
  preview?: string,
): ConfigEdit {
  return {
    scope: "project",
    targetPath,
    beforeText,
    afterText,
    preview:
      preview ??
      `--- ${targetPath}\n+++ planned change\n(no managed session-bus entry)`,
  };
}

export async function applyEdit(edit: ConfigEdit): Promise<string | undefined> {
  if (edit.beforeText === edit.afterText) return undefined;
  await mkdir(dirname(edit.targetPath), { recursive: true });
  let backup: string | undefined;
  let mode = 0o600;
  let actual: string | undefined;
  try {
    const status = await lstat(edit.targetPath);
    if (!status.isFile())
      throw new Error(
        `Refusing to update a non-regular config file: ${edit.targetPath}`,
      );
    mode = status.mode & 0o777;
    actual = await readFile(edit.targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (actual !== edit.beforeText)
    throw new Error(
      `Configuration changed after preview; run install again: ${edit.targetPath}`,
    );
  if (edit.beforeText !== undefined) {
    backup = `${edit.targetPath}.session-bus.bak-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    await copyFile(edit.targetPath, backup);
  }
  if (edit.afterText === undefined || edit.afterText.trim() === "{}") {
    const empty =
      edit.afterText === undefined ||
      Object.keys(parseJsonConfig(edit.afterText)).length === 0;
    if (empty) {
      const { unlink } = await import("node:fs/promises");
      await unlink(edit.targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return backup;
    }
  }
  const temporary = `${edit.targetPath}.session-bus.tmp-${process.pid}`;
  await writeFile(temporary, edit.afterText ?? "", { mode });
  await rename(temporary, edit.targetPath);
  return backup;
}

export function entryEnvironment(input: InstallInput, harness: string) {
  return {
    [MANAGED]: "true",
    SESSION_BUS_URL: input.hubUrl,
    SESSION_BUS_PROJECT_ROOT: input.projectRoot,
    SESSION_BUS_SESSION_NAME: `${harness}-${input.projectRoot.split("/").filter(Boolean).at(-1) ?? "project"}`,
    SESSION_BUS_HARNESS: harness,
    SESSION_BUS_HARNESS_VERSION: "unknown",
    SESSION_BUS_CAPABILITIES: "collaboration,context-sharing",
    SESSION_BUS_CURRENT_FOCUS: "",
  };
}
