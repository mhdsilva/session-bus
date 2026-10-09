import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

const children: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.close()));
});

describe("stdio boundary", () => {
  it("negotiates MCP, lists tools, and returns hub failures as tool errors", async () => {
    const hub = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "POST" && request.url === "/api/v1/sessions") {
        response.writeHead(201).end(
          JSON.stringify({
            session: { id: "00000000-0000-4000-8000-000000000001" },
            instanceToken: "test-token",
          }),
        );
      } else if (request.url === "/api/v1/sessions/heartbeat")
        response.end(JSON.stringify({ session: {} }));
      else
        response.writeHead(503).end(
          JSON.stringify({
            error: { code: "HUB_UNAVAILABLE", message: "Hub is unavailable" },
          }),
        );
    });
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    const address = hub.address();
    if (!address || typeof address === "string")
      throw new Error("missing test hub address");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/main.js", import.meta.url))],
      cwd: process.cwd(),
      env: {
        ...process.env,
        SESSION_BUS_URL: `http://127.0.0.1:${address.port}`,
        SESSION_BUS_PROJECT_ROOT: process.cwd(),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1" });
    children.push({
      close: async () => {
        await client.close().catch(() => {});
        await new Promise<void>((resolve) => hub.close(() => resolve()));
      },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(19);
    const result = await client.callTool({
      name: "list_sessions",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("HUB_UNAVAILABLE"),
      }),
    );
  });
});
