import { describe, expect, it, vi } from "vitest";
import { startSession } from "./session.js";
import { toolDefinitions } from "./tools.js";

const profile = {
  name: "codex-api",
  harness: { name: "codex", version: "1" },
  projectRoot: "/repo",
  capabilities: [],
  currentFocus: "",
  metadata: {},
};

describe("MCP bridge tool contract", () => {
  it("registers one bridge identity and never exposes credentials or sender identity as tool arguments", async () => {
    const hub = {
      registerSession: vi
        .fn()
        .mockResolvedValue({ id: "id", instanceToken: "secret" }),
      request: vi.fn().mockResolvedValue({}),
    };
    const shutdown = await startSession(hub, profile);
    expect(hub.registerSession).toHaveBeenCalledOnce();
    expect(toolDefinitions).toHaveLength(19);
    for (const [name, , schema] of toolDefinitions) {
      const shape = (schema as any).shape;
      expect(shape).not.toHaveProperty("instanceToken");
      expect(shape).not.toHaveProperty("senderId");
      if (name === "send_message")
        expect(Object.keys(shape)).toContain("roomId");
    }
    await shutdown();
  });

  it("maps all tools to hub operations", () => {
    expect(new Set(toolDefinitions.map(([name]) => name)).size).toBe(19);
  });
});

const roomId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const sessionId = "00000000-0000-4000-8000-000000000004";
const argsByTool: Record<string, Record<string, unknown>> = {
  register_session: { currentFocus: "implementing" },
  heartbeat: {},
  update_session: { currentFocus: "reviewing" },
  list_sessions: {},
  create_room: {
    title: "Pair",
    objective: "Ship feature",
    idempotencyKey: "room-create-1",
  },
  invite_sessions: {
    roomId,
    sessionIds: [sessionId],
    idempotencyKey: "invite-1",
  },
  list_invitations: {},
  respond_to_invitation: { roomId, accept: true, idempotencyKey: "respond-1" },
  list_rooms: {},
  get_room_context: { roomId },
  send_message: { roomId, text: "hello", idempotencyKey: "message-1" },
  list_events: { roomId },
  wait_for_events: { afterByRoom: {} },
  create_task: { roomId, title: "Implement", idempotencyKey: "task-create-1" },
  claim_task: { taskId, idempotencyKey: "claim-1" },
  update_task: { taskId, status: "completed", idempotencyKey: "task-update-1" },
  publish_artifact: {
    roomId,
    kind: "text",
    uri: "result",
    summary: "Done",
    idempotencyKey: "artifact-1",
  },
  leave_room: { roomId, idempotencyKey: "leave-1" },
  close_room: { roomId, summary: "Done", idempotencyKey: "close-1" },
};

it("routes every exposed tool through the authenticated hub client", async () => {
  const hub = {
    registerSession: vi.fn(),
    request: vi.fn().mockResolvedValue({ ok: true }),
  };
  for (const [name, , schema, invoke] of toolDefinitions) {
    const input = schema.parse(argsByTool[name]);
    await (
      invoke as (h: typeof hub, a: any, p: typeof profile) => Promise<unknown>
    )(hub, input, profile);
  }
  expect(hub.request).toHaveBeenCalledTimes(19);
  const createRoomCall = hub.request.mock.calls.find(
    ([path]) => path === "/api/v1/rooms",
  );
  expect(createRoomCall?.[1]?.idempotency).toBe("room-create-1");
  expect(
    hub.request.mock.calls.some(([path]) =>
      String(path).includes("/events/wait"),
    ),
  ).toBe(true);
});
