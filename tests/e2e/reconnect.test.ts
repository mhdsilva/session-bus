import { startTestSystem } from "@session-bus/test-support";
import { describe, expect, it } from "vitest";

describe("MCP bridge reconnect recovery", () => {
  it("recovers missed room messages from the last event cursor", async () => {
    const system = await startTestSystem();
    try {
      const alice = await system.startMcpSession("codex-owner", "codex");
      const bob = await system.startMcpSession("claude-review", "claude-code");
      const created = await alice.call("create_room", {
        title: "Reconnect review",
        objective: "Keep event delivery contiguous",
        idempotencyKey: "reconnect-room",
      });
      const roomId = created.room.id as string;
      await alice.call("invite_sessions", {
        roomId,
        sessionIds: [bob.sessionId],
        idempotencyKey: "reconnect-invite-bob",
      });
      await bob.call("respond_to_invitation", {
        roomId,
        accept: true,
        idempotencyKey: "reconnect-bob-accept",
      });
      const initial = await bob.call("list_events", {
        roomId,
        after: 0,
        limit: 100,
      });
      const cursor = (initial.items.at(-1)?.sequence ?? 0) as number;
      await bob.close();

      await alice.call("send_message", {
        roomId,
        text: "First message while disconnected",
        idempotencyKey: "reconnect-message-1",
      });
      await alice.call("send_message", {
        roomId,
        text: "Second message while disconnected",
        idempotencyKey: "reconnect-message-2",
      });

      const reconnected = await system.startMcpSession(
        "claude-review-restarted",
        "claude-code",
      );
      await alice.call("invite_sessions", {
        roomId,
        sessionIds: [reconnected.sessionId],
        idempotencyKey: "reconnect-invite-restarted",
      });
      await reconnected.call("respond_to_invitation", {
        roomId,
        accept: true,
        idempotencyKey: "reconnect-restarted-accept",
      });
      const recovered = await reconnected.call("list_events", {
        roomId,
        after: cursor,
        limit: 100,
      });
      const missedMessages = recovered.items
        .filter((event) => event.type === "message")
        .map((event) => event.payload.text);
      expect(missedMessages).toEqual([
        "First message while disconnected",
        "Second message while disconnected",
      ]);

      const nextCursor = recovered.items.at(-1)?.sequence ?? cursor;
      await alice.call("send_message", {
        roomId,
        text: "Live after reconnect",
        idempotencyKey: "reconnect-message-live",
      });
      const live = await reconnected.call("wait_for_events", {
        afterByRoom: { [roomId]: nextCursor },
        timeoutMs: 1_000,
      });
      expect(live.items.at(-1)?.payload.text).toBe("Live after reconnect");
    } finally {
      await system.close();
    }
  });
});
