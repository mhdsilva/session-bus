import type {
  Artifact,
  Room,
  RoomEvent,
  Session,
  SharedTask,
} from "@session-bus/protocol";
import { type FormEvent, useState } from "react";
import { ContextPanel } from "./context-panel.js";

const OPERATOR_ID = "00000000-0000-4000-8000-000000000001";
const labels: Record<string, string> = {
  message: "Message",
  question: "Question",
  decision: "Decision",
  conflict_reported: "Blocker",
  member_invited: "Invitation",
  member_joined: "Joined room",
  member_left: "Left room",
  room_closed: "Room closed",
  task_created: "Task created",
  task_updated: "Task updated",
  artifact_published: "Artifact published",
};

export function RoomView({
  room,
  sessions,
  events,
  tasks,
  decisions,
  artifacts,
  connected,
  onSend,
}: {
  room: Room;
  sessions: Session[];
  events: RoomEvent[];
  tasks: SharedTask[];
  decisions: RoomEvent[];
  artifacts: Artifact[];
  connected: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const names = new Map(sessions.map((session) => [session.id, session.name]));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending || room.status !== "open") return;
    setSending(true);
    setSendError("");
    try {
      await onSend(text);
      setDraft("");
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Message could not be sent.",
      );
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="room-layout">
      <main className="conversation-column">
        <header className="room-header">
          <div>
            <div className="eyebrow">COLLABORATION ROOM</div>
            <h1>{room.title}</h1>
            <p>{room.objective}</p>
            {room.contextSummary ? (
              <p className="summary">{room.contextSummary}</p>
            ) : null}
          </div>
          <span className={`room-state-badge status-${room.status}`}>
            {room.status}
          </span>
        </header>
        <div className="stream-status" aria-live="polite">
          <span
            className={`stream-indicator ${connected ? "is-connected" : ""}`}
            aria-hidden="true"
          />
          {connected
            ? "Live updates connected"
            : "Reconnecting · catching up on room activity"}
        </div>
        <section
          className="event-feed"
          aria-label="Room conversation"
          aria-live="polite"
        >
          {events.length === 0 ? (
            <div className="empty-conversation">
              <span className="empty-icon" aria-hidden="true">
                ✦
              </span>
              <h2>Conversation starts here</h2>
              <p>Room updates and agent messages will appear as they happen.</p>
            </div>
          ) : (
            events.map((event) => {
              const text = String(
                event.payload.text ??
                  event.payload.summary ??
                  event.payload.title ??
                  "",
              );
              const sender =
                event.senderId === OPERATOR_ID
                  ? "You"
                  : (names.get(event.senderId) ?? "Agent");
              return (
                <article
                  className={`event-card event-${event.type}`}
                  key={event.id}
                >
                  <div className="event-avatar" aria-hidden="true">
                    {sender === "You" ? "Y" : sender.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="event-content">
                    <div className="event-meta">
                      <strong>{sender}</strong>
                      <span>
                        {labels[event.type] ?? event.type.replaceAll("_", " ")}
                      </span>
                      <time dateTime={event.createdAt}>
                        {new Date(event.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    {text ? (
                      <p>{text}</p>
                    ) : event.type === "member_invited" ? (
                      <p>
                        {names.get(String(event.payload.sessionId)) ??
                          "A session"}{" "}
                        was invited
                      </p>
                    ) : null}
                  </div>
                </article>
              );
            })
          )}
        </section>
        <form className="message-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="room-message">
            Message the room
          </label>
          <textarea
            id="room-message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              room.status === "open"
                ? "Add a note or question for the agents…"
                : "This room is closed"
            }
            disabled={room.status !== "open" || sending}
            rows={2}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-footer">
            <span>
              {sendError ||
                "Your message is shared with everyone in this room."}
            </span>
            <button
              className="send-button"
              type="submit"
              disabled={room.status !== "open" || sending || !draft.trim()}
            >
              {sending ? "Sending…" : "Send message"}
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      </main>
      <ContextPanel
        sessions={sessions}
        tasks={tasks}
        decisions={decisions}
        artifacts={artifacts}
      />
    </div>
  );
}
