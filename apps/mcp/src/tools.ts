import { McpServer } from "@modelcontextprotocol/server";
import { mcpToolOutputSchemas } from "@session-bus/protocol";
import { z } from "zod/v4";
import { type HubClient, HubError } from "./hub-client.js";

export const toolDefinitions = [
  [
    "register_session",
    "Refresh this session profile and current focus",
    z.object({ currentFocus: z.string().max(500).optional() }),
    (h: HubClient, a: any, profile: Record<string, unknown>) =>
      h.request("/api/v1/sessions/me", {
        method: "PATCH",
        body: { ...profile, ...a },
      }),
  ],
  [
    "heartbeat",
    "Refresh session presence",
    z.object({ status: z.enum(["available", "busy", "away"]).optional() }),
    (h: HubClient, a: any) =>
      h.request("/api/v1/sessions/heartbeat", { method: "POST", body: a }),
  ],
  [
    "update_session",
    "Update session focus and profile",
    z.object({
      name: z.string().optional(),
      currentFocus: z.string().max(500).optional(),
      capabilities: z.array(z.string()).optional(),
    }),
    (h: HubClient, a: any, profile: Record<string, unknown>) =>
      h.request("/api/v1/sessions/me", {
        method: "PATCH",
        body: { ...profile, ...a },
      }),
  ],
  [
    "list_sessions",
    "Discover registered sessions",
    z.object({}),
    (h: HubClient) => h.request("/api/v1/sessions"),
  ],
  [
    "create_room",
    "Create a collaboration room",
    z.object({
      title: z.string().min(1),
      objective: z.string().min(1),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) =>
      h.request("/api/v1/rooms", {
        method: "POST",
        body: a,
        idempotency: a.idempotencyKey,
      }),
  ],
  [
    "invite_sessions",
    "Invite sessions to a room",
    z.object({
      roomId: z.string().uuid(),
      sessionIds: z.array(z.string().uuid()).min(1),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) =>
      h.request(`/api/v1/rooms/${a.roomId}/invitations`, {
        method: "POST",
        body: { sessionIds: a.sessionIds },
        idempotency: a.idempotencyKey,
      }),
  ],
  [
    "list_invitations",
    "List pending room invitations",
    z.object({}),
    (h: HubClient) => h.request("/api/v1/invitations"),
  ],
  [
    "respond_to_invitation",
    "Accept or decline a room invitation",
    z.object({
      roomId: z.string().uuid(),
      accept: z.boolean(),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) =>
      h.request(`/api/v1/rooms/${a.roomId}/invitation`, {
        method: "POST",
        body: { accept: a.accept },
        idempotency: a.idempotencyKey,
      }),
  ],
  [
    "list_rooms",
    "List rooms this session belongs to",
    z.object({}),
    (h: HubClient) => h.request("/api/v1/rooms"),
  ],
  [
    "get_room_context",
    "Read shared room context",
    z.object({ roomId: z.string().uuid() }),
    (h: HubClient, a: any) => h.request(`/api/v1/rooms/${a.roomId}/context`),
  ],
  [
    "send_message",
    "Send a message, question, decision, or blocker",
    z.object({
      roomId: z.string().uuid(),
      type: z
        .enum(["message", "question", "decision", "conflict_reported"])
        .optional(),
      text: z.string().min(1),
      replyToEventId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) => {
      const { roomId, ...body } = a;
      return h.request(`/api/v1/rooms/${roomId}/messages`, {
        method: "POST",
        body,
        idempotency: a.idempotencyKey,
      });
    },
  ],
  [
    "list_events",
    "Read room events after a sequence",
    z.object({
      roomId: z.string().uuid(),
      after: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    (h: HubClient, a: any) =>
      h.request(
        `/api/v1/rooms/${a.roomId}/events?after=${a.after}&limit=${a.limit}`,
      ),
  ],
  [
    "wait_for_events",
    "Wait briefly for new room events",
    z.object({
      afterByRoom: z.record(z.string().uuid(), z.number().int().nonnegative()),
      timeoutMs: z.number().int().min(1).max(30_000).default(25_000),
    }),
    (h: HubClient, a: any) =>
      h.request(
        `/api/v1/events/wait?afterByRoom=${encodeURIComponent(JSON.stringify(a.afterByRoom))}&timeoutMs=${a.timeoutMs}`,
      ),
  ],
  [
    "create_task",
    "Create shared work",
    z.object({
      roomId: z.string().uuid(),
      title: z.string().min(1),
      description: z.string().optional(),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) => {
      const { roomId, ...body } = a;
      return h.request(`/api/v1/rooms/${roomId}/tasks`, {
        method: "POST",
        body,
        idempotency: a.idempotencyKey,
      });
    },
  ],
  [
    "claim_task",
    "Claim a shared task",
    z.object({
      taskId: z.string().uuid(),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) =>
      h.request(`/api/v1/tasks/${a.taskId}/claim`, {
        method: "POST",
        body: {},
        idempotency: a.idempotencyKey,
      }),
  ],
  [
    "update_task",
    "Mark a task blocked, completed, or cancelled",
    z.object({
      taskId: z.string().uuid(),
      status: z.enum(["blocked", "completed", "cancelled"]),
      resultSummary: z.string().optional(),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) => {
      const { taskId, ...body } = a;
      return h.request(`/api/v1/tasks/${taskId}`, {
        method: "PATCH",
        body,
        idempotency: a.idempotencyKey,
      });
    },
  ],
  [
    "publish_artifact",
    "Publish a file, patch, commit, URL, or text reference",
    z.object({
      roomId: z.string().uuid(),
      kind: z.enum(["file", "patch", "commit", "url", "text"]),
      uri: z.string().min(1),
      summary: z.string().optional(),
      contentHash: z.string().optional(),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) => {
      const { roomId, ...body } = a;
      return h.request(`/api/v1/rooms/${roomId}/artifacts`, {
        method: "POST",
        body,
        idempotency: a.idempotencyKey,
      });
    },
  ],
  [
    "leave_room",
    "Leave a collaboration room",
    z.object({
      roomId: z.string().uuid(),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) =>
      h.request(`/api/v1/rooms/${a.roomId}/leave`, {
        method: "POST",
        body: {},
        idempotency: a.idempotencyKey,
      }),
  ],
  [
    "close_room",
    "Close a room with a summary",
    z.object({
      roomId: z.string().uuid(),
      summary: z.string(),
      idempotencyKey: z.string().min(1).max(200),
    }),
    (h: HubClient, a: any) =>
      h.request(`/api/v1/rooms/${a.roomId}/close`, {
        method: "POST",
        body: { summary: a.summary },
        idempotency: a.idempotencyKey,
      }),
  ],
] as const;

export function buildMcpServer({
  hub,
  profile,
}: {
  hub: HubClient;
  profile: Record<string, unknown>;
}) {
  const server = new McpServer(
    {
      name: "session-bus",
      version: "0.1.0",
      description: "Collaborate through shared rooms.",
    },
    {
      instructions:
        "Keep your current focus updated, check invitations, accept only relevant rooms, call get_room_context after joining, communicate decisions and blockers, publish results, and call wait_for_events while actively collaborating. Never share secrets, credentials, or private transcripts.",
    },
  );
  let currentProfile = { ...profile };
  for (const [name, description, schema, invoke] of toolDefinitions) {
    (server as any).registerTool(
      name,
      { description, inputSchema: schema },
      async (args: any) => {
        try {
          const result = await (
            invoke as (
              hub: HubClient,
              args: any,
              profile: Record<string, unknown>,
            ) => Promise<any>
          )(hub, args, currentProfile);
          const structuredContent =
            mcpToolOutputSchemas[
              name as keyof typeof mcpToolOutputSchemas
            ].parse(result);
          if (name === "register_session" || name === "update_session") {
            const { idempotencyKey: _idempotencyKey, ...profileUpdate } = args;
            currentProfile = { ...currentProfile, ...profileUpdate };
          }
          return {
            content: [
              { type: "text", text: JSON.stringify(structuredContent) },
            ],
            structuredContent,
          };
        } catch (error) {
          const expected = error instanceof HubError;
          const code = expected ? error.code : "INTERNAL_ERROR";
          const message =
            error instanceof Error ? error.message : "Unexpected bridge error";
          if (!expected) console.error("session-bus MCP tool error", error);
          return {
            isError: true,
            content: [{ type: "text", text: `${code}: ${message}` }],
            structuredContent: { error: { code, message } },
          };
        }
      },
    );
  }
  return server;
}
