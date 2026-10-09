import type { HubClient } from "./hub-client.js";

export async function startSession(
  hub: HubClient,
  profile: Record<string, unknown>,
) {
  await hub.registerSession(profile);
  const timer = setInterval(() => {
    void hub
      .request("/api/v1/sessions/heartbeat", { method: "POST", body: {} })
      .catch((error) => console.error("session-bus heartbeat failed", error));
  }, 10_000);
  timer.unref();
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try {
      await hub.request("/api/v1/sessions/heartbeat", {
        method: "POST",
        body: { status: "away" },
      });
    } catch (error) {
      console.error("session-bus shutdown heartbeat failed", error);
    }
  };
}
