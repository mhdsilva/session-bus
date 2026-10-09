import type { SharedTask } from "@session-bus/protocol";

export function TaskBoard({
  tasks,
  names,
}: {
  tasks: SharedTask[];
  names: Map<string, string>;
}) {
  return (
    <section className="panel-section" aria-labelledby="tasks-heading">
      <div className="section-heading">
        <h3 id="tasks-heading">Shared tasks</h3>
        <span className="count-pill">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <p className="muted small">No tasks have been created.</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <div className="task-title">
                <strong>{task.title}</strong>
                <span className={`task-state task-${task.status}`}>
                  {task.status}
                </span>
              </div>
              {task.description ? <p>{task.description}</p> : null}
              {task.ownerSessionId ? (
                <small>
                  Owner: {names.get(task.ownerSessionId) ?? "Agent"}
                </small>
              ) : null}
              {task.resultSummary ? (
                <p className="task-result">{task.resultSummary}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
