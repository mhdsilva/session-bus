export type Harness = "claude-code" | "codex" | "opencode";

export interface InstallInput {
  executable: string;
  projectRoot: string;
  hubUrl: string;
}

export interface ConfigEdit {
  scope: "project";
  targetPath: string;
  beforeText: string | undefined;
  afterText: string | undefined;
  preview: string;
}

export interface HarnessIntegration {
  name: Harness;
  configPath(projectRoot: string): string;
  detect(projectRoot: string): Promise<boolean>;
  planInstall(input: InstallInput): Promise<ConfigEdit>;
  planRemove(projectRoot: string): Promise<ConfigEdit>;
  apply(edit: ConfigEdit): Promise<string | undefined>;
}

export function validateLoopbackHubUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Hub URL must be HTTP(S) on a loopback host without credentials",
    );
  }
  return url.toString().replace(/\/$/, "");
}
