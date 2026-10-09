#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectIntegrations, integrations } from "./integrations/detect.js";
import type { Harness } from "./integrations/types.js";

const help = `Session Bus local CLI

Usage:
  session-bus hub
  session-bus doctor [--project <absolute-path>]
  session-bus install <claude-code|codex|opencode> --project <absolute-path> [--dry-run]
  session-bus install <claude-code|codex|opencode> --project <absolute-path> --remove

Install edits only the selected project's harness configuration. Existing files
are backed up before changes. --dry-run prints the planned change without writing.
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function projectPath(args: string[]): string {
  const value = option(args, "--project");
  if (!value || !isAbsolute(value))
    throw new Error("--project must be an absolute path");
  return resolve(value);
}

async function executablePath(): Promise<string> {
  const script = join(dirname(fileURLToPath(import.meta.url)), "main.js");
  await access(script, constants.R_OK);
  return script;
}

async function runHub(): Promise<void> {
  const hubMain = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../hub/dist/main.js",
  );
  await access(hubMain, constants.X_OK).catch(() => access(hubMain));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [hubMain], {
    stdio: "inherit",
    env: process.env,
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  process.once("SIGINT", () => child.kill("SIGINT"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));
}

async function doctor(projectRoot: string): Promise<void> {
  const checks: [string, () => Promise<string>][] = [
    [
      "Node.js >=22.12",
      async () => {
        const [majorPart, minorPart] = process.versions.node.split(".");
        const major = Number(majorPart);
        const minor = Number(minorPart);
        if (major < 22 || (major === 22 && minor < 12))
          throw new Error(`found ${process.versions.node}`);
        return process.versions.node;
      },
    ],
    [
      "loopback hub",
      async () => {
        const hubUrl = new URL(
          process.env.SESSION_BUS_URL ?? "http://127.0.0.1:7345",
        );
        hubUrl.pathname = "/api/v1/sessions";
        hubUrl.search = "";
        hubUrl.hash = "";
        const response = await fetch(hubUrl, {
          signal: AbortSignal.timeout(1500),
        });
        if ([401, 403].includes(response.status))
          return `reachable (HTTP ${response.status})`;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return `reachable (HTTP ${response.status})`;
      },
    ],
    [
      "database directory writable",
      async () => {
        const dbPath = resolve(
          process.env.SESSION_BUS_DB ?? ".session-bus/session-bus.sqlite",
        );
        const parent = dirname(dbPath);
        await mkdir(parent, { recursive: true });
        const probe = join(parent, `.session-bus-doctor-${process.pid}`);
        const file = await open(probe, "wx", 0o600);
        await file.close();
        const { unlink } = await import("node:fs/promises");
        await unlink(probe);
        return parent;
      },
    ],
    [
      "MCP bridge executable",
      async () => {
        const path = await executablePath();
        await access(path, constants.R_OK);
        return path;
      },
    ],
    [
      "project harness configuration",
      async () => {
        const found = await detectIntegrations(projectRoot);
        return (
          found
            .filter((item) => item.configured)
            .map((item) => item.harness)
            .join(", ") || "none installed"
        );
      },
    ],
  ];
  let failed = false;
  for (const [label, check] of checks) {
    try {
      console.log(`PASS ${label}: ${await check()}`);
    } catch (error) {
      failed = true;
      console.log(`FAIL ${label}: ${(error as Error).message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function install(args: string[]): Promise<void> {
  const harness = args[0] as Harness | undefined;
  if (!harness || !(harness in integrations))
    throw new Error("Choose claude-code, codex, or opencode");
  const root = projectPath(args);
  const integration = integrations[harness];
  const remove = args.includes("--remove");
  const dryRun = args.includes("--dry-run");
  let edit: Awaited<ReturnType<(typeof integration)["planRemove"]>>;
  if (remove) edit = await integration.planRemove(root);
  else {
    const executable = await executablePath();
    edit = await integration.planInstall({
      executable,
      projectRoot: root,
      hubUrl: process.env.SESSION_BUS_URL ?? "http://127.0.0.1:7345",
    });
  }
  console.log(
    `${dryRun ? "DRY RUN" : "PLAN"} ${integration.name} project configuration: ${edit.targetPath}`,
  );
  console.log(edit.preview);
  if (dryRun) return;
  const backup = await integration.apply(edit);
  console.log(backup ? `Backup: ${backup}` : "No backup needed.");
  console.log(
    remove
      ? "Managed Session Bus entry removed."
      : "Session Bus integration installed.",
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    console.log(help);
    return;
  }
  if (command === "hub") return runHub();
  if (command === "doctor")
    return doctor(
      args.includes("--project") ? projectPath(args) : process.cwd(),
    );
  if (command === "install") return install(args);
  throw new Error(`Unknown command: ${command}\n\n${help}`);
}

main().catch((error) => {
  console.error(`session-bus: ${(error as Error).message}`);
  process.exitCode = 1;
});
