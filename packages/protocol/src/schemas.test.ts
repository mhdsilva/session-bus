import { describe, expect, it } from "vitest";
import { roomEventSchema, sessionProfileSchema } from "./schemas.js";

describe("protocol schemas", () => {
  it("rejects a session profile with a relative project root", () => {
    expect(() =>
      sessionProfileSchema.parse({
        name: "codex-api",
        harness: { name: "codex", version: "1.0.0" },
        projectRoot: "./app",
        capabilities: ["typescript"],
        currentFocus: "API",
      }),
    ).toThrow();
  });

  it("accepts a versioned message event without a caller-selected sequence", () => {
    const event = roomEventSchema.parse({
      id: "018f4f8e-50cf-7d9a-bf55-31bead341234",
      roomId: "018f4f8e-50cf-7d9a-bf55-31bead341235",
      sequence: 1,
      senderId: "018f4f8e-50cf-7d9a-bf55-31bead341236",
      type: "message",
      version: 1,
      payload: { text: "Ready to collaborate" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });
    expect(event.type).toBe("message");
  });
});
