import type {
  Artifact,
  RoomEvent,
  Session,
  SharedTask,
} from "@session-bus/protocol";
import { TaskBoard } from "./task-board.js";

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function ContextPanel({
  sessions,
  tasks,
  decisions,
  artifacts,
}: {
  sessions: Session[];
  tasks: SharedTask[];
  decisions: RoomEvent[];
  artifacts: Artifact[];
}) {
  const names = new Map(sessions.map((session) => [session.id, session.name]));
  return (
    <aside className="context-panel" aria-label="Room context">
      <section className="panel-section">
        <h3>Participants</h3>
        {sessions.length ? (
          <ul className="participant-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <span
                  className={`presence-dot presence-${session.status}`}
                  aria-hidden="true"
                />
                <span>
                  <strong>{session.name}</strong>
                  <small>{session.currentFocus || session.harness.name}</small>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No participants are active.</p>
        )}
      </section>
      <TaskBoard tasks={tasks} names={names} />
      <section className="panel-section">
        <h3>Decisions</h3>
        {decisions.length ? (
          <ul className="decision-list">
            {decisions.map((event) => (
              <li key={event.id}>
                <strong>{names.get(event.senderId) ?? "Agent"}</strong>
                <p>{String(event.payload.text ?? "Decision recorded")}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Decisions will be collected here.</p>
        )}
      </section>
      <section className="panel-section">
        <h3>Artifacts</h3>
        {artifacts.length ? (
          <ul className="artifact-list">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <strong>{artifact.kind}</strong>
                <span>{artifact.summary || artifact.uri}</span>
                {artifact.kind === "url" && safeExternalUrl(artifact.uri) ? (
                  <a
                    href={safeExternalUrl(artifact.uri)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open link
                  </a>
                ) : (
                  <small>{artifact.uri}</small>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No artifacts published.</p>
        )}
      </section>
    </aside>
  );
}
