import type { Session } from "@session-bus/protocol";

export function SessionList({ sessions }: { sessions: Session[] }) {
  return (
    <section className="side-section" aria-labelledby="sessions-heading">
      <div className="section-heading">
        <h2 id="sessions-heading">Sessions</h2>
        <span className="count-pill">{sessions.length}</span>
      </div>
      {sessions.length === 0 ? (
        <p className="muted small">No agent sessions yet.</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id} className="session-item">
              <span
                className={`presence-dot presence-${session.status}`}
                aria-hidden="true"
              />
              <div className="session-copy">
                <strong>{session.name}</strong>
                <span>
                  {session.harness.name} · {session.status}
                </span>
                <small>{session.currentFocus || session.projectRoot}</small>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
