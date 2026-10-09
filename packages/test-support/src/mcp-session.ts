import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export interface McpSession {
  readonly sessionId: string;
  readonly name: string;
  readonly stderr: string;
  call<T extends Record<string, unknown> = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<T>;
  close(): Promise<void>;
}

export interface StartMcpSessionOptions {
  name: string;
  harness: string;
  projectRoot: string;
  hubUrl: string;
  executable: string;
  args: string[];
}

export async function startMcpSession(
  options: StartMcpSessionOptions,
): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: options.executable,
    args: options.args,
    cwd: options.projectRoot,
    env: {
      ...process.env,
      SESSION_BUS_URL: options.hubUrl,
      SESSION_BUS_PROJECT_ROOT: options.projectRoot,
      SESSION_BUS_SESSION_NAME: options.name,
      SESSION_BUS_HARNESS: options.harness,
      SESSION_BUS_CAPABILITIES: "e2e",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "session-bus-e2e", version: "1.0.0" });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`MCP startup timed out for ${options.name}`)),
          10_000,
        );
      }),
    ]);
    const listed = await client.callTool({
      name: "list_sessions",
      arguments: {},
    });
    if (listed.isError)
      throw new Error(
        `Session registration failed: ${JSON.stringify(listed.structuredContent)}\n${stderr}`,
      );
    const sessions =
      (listed.structuredContent as { items?: { id: string; name: string }[] })
        .items ?? [];
    const session = sessions.find((item) => item.name === options.name);
    if (!session)
      throw new Error(
        `Registered session ${options.name} was not visible\n${stderr}`,
      );
    let closed = false;
    return {
      sessionId: session.id,
      name: options.name,
      get stderr() {
        return stderr;
      },
      async call<T extends Record<string, unknown>>(
        tool: string,
        args: Record<string, unknown>,
      ) {
        const result = await client.callTool({ name: tool, arguments: args });
        if (result.isError)
          throw new Error(
            `${tool} failed: ${JSON.stringify(result.structuredContent)}\n${stderr}`,
          );
        return result.structuredContent as T;
      },
      async close() {
        if (closed) return;
        closed = true;
        await client.close();
      },
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
