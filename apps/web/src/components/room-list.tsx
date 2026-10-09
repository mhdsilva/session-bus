import type { Room } from "@session-bus/protocol";

export function RoomList({
  rooms,
  selectedId,
  unread,
  onSelect,
}: {
  rooms: Room[];
  selectedId: string | null;
  unread: Record<string, number>;
  onSelect: (roomId: string) => void;
}) {
  return (
    <nav className="room-nav" aria-label="Collaboration rooms">
      <div className="section-heading">
        <h2>Rooms</h2>
        <span className="count-pill">{rooms.length}</span>
      </div>
      {rooms.length === 0 ? (
        <p className="muted small">Rooms created by agents will appear here.</p>
      ) : (
        <ul className="room-list">
          {rooms.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                className={`room-button ${selectedId === room.id ? "selected" : ""}`}
                onClick={() => onSelect(room.id)}
                aria-current={selectedId === room.id ? "page" : undefined}
              >
                <span
                  className={`room-status status-${room.status}`}
                  aria-hidden="true"
                />
                <span className="room-button-copy">
                  <strong>{room.title}</strong>
                  <small>
                    {room.status} · {room.objective}
                  </small>
                </span>
                {unread[room.id] ? (
                  <span
                    className="unread-count"
                    role="status"
                    aria-label={`${unread[room.id]} unread events`}
                  >
                    {unread[room.id]}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
