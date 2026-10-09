import { startTestSystem } from "@session-bus/test-support";
import { describe, expect, it } from "vitest";

describe("cross-process MCP collaboration", () => {
  it("lets three independent sessions complete a room lifecycle", async () => {
    const system = await startTestSystem();
    try {
      const alice = await system.startMcpSession("codex-api", "codex");
      const bob = await system.startMcpSession("claude-review", "claude-code");
      const carol = await system.startMcpSession("opencode-tests", "opencode");

      const created = await alice.call("create_room", {
        title: "Authentication",
        objective: "Implement and verify auth",
        idempotencyKey: "room-1",
      });
      const roomId = created.room.id;
      await alice.call("invite_sessions", {
        roomId,
        sessionIds: [bob.sessionId, carol.sessionId],
        idempotencyKey: "invite-1",
      });
      await bob.call("respond_to_invitation", {
        roomId,
        accept: true,
        idempotencyKey: "bob-accept",
      });
      await carol.call("respond_to_invitation", {
        roomId,
        accept: true,
        idempotencyKey: "carol-accept",
      });
      const createdTask = await alice.call("create_task", {
        roomId,
        title: "Review schema",
        description: "Verify DB changes",
        idempotencyKey: "task-1",
      });
      await bob.call("claim_task", {
        taskId: createdTask.task.id,
        idempotencyKey: "claim-1",
      });
      await bob.call("update_task", {
        taskId: createdTask.task.id,
        status: "completed",
        resultSummary: "Schema approved",
        idempotencyKey: "complete-1",
      });
      await alice.call("close_room", {
        roomId,
        summary: "Implementation and review complete",
        idempotencyKey: "close-1",
      });
      const context = await carol.call("get_room_context", { roomId });
      expect(context.context.room.status).toBe("closed");
      expect(context.context.tasks[0]?.status).toBe("completed");
    } finally {
      await system.close();
    }
  });
});
