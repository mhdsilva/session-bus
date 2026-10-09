import { roomEventSchema } from "@session-bus/protocol";
import type { RealtimeClient } from "../types.js";

export function createWebSocketRealtime(): RealtimeClient {
  return {
    connect(ticket, afterByRoom, onEvent, onReady, onClose) {
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${scheme}//${window.location.host}/api/v1/ws`,
      );
      let pendingEvents = Promise.resolve();
      let deliveryFailed = false;
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "subscribe", ticket, afterByRoom }));
      });
      socket.addEventListener("message", (message) => {
        try {
          const frame: unknown = JSON.parse(String(message.data));
          if (typeof frame !== "object" || frame === null || !("type" in frame))
            return;
          if (frame.type === "ready") {
            void pendingEvents.then(() => {
              if (!deliveryFailed) onReady();
            });
            return;
          }
          if (!("event" in frame)) return;
          const parsed = roomEventSchema.safeParse(frame.event);
          if (parsed.success)
            pendingEvents = pendingEvents
              .then(() => onEvent(parsed.data))
              .catch(() => {
                deliveryFailed = true;
                socket.close();
              });
        } catch {
          // Ignore malformed frames and let the next cursor repair recover state.
        }
      });
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", () => socket.close());
      return { close: () => socket.close() };
    },
  };
}
