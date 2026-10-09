import type { Room, RoomEvent, Session } from "@session-bus/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createObserverApi } from "./api/client.js";
import { RoomList } from "./components/room-list.js";
import { RoomView } from "./components/room-view.js";
import { SessionList } from "./components/session-list.js";
import {
  type ConnectionState,
  useRoomStream,
} from "./realtime/use-room-stream.js";
import { createWebSocketRealtime } from "./realtime/websocket.js";
import type {
  ObserverApi,
  OperatorRoomContext,
  RealtimeClient,
} from "./types.js";
import "./styles.css";

interface RoomEntry {
  room: Room;
  memberships: OperatorRoomContext["memberships"];
}
const defaultApi = createObserverApi();
const defaultRealtime = createWebSocketRealtime();
const stateLabel: Record<ConnectionState, string> = {
  connecting: "Connecting to the local hub…",
  connected: "Connected to local hub",
  reconnecting: "Connection interrupted · reconnecting…",
  offline: "Waiting for room activity",
};

export function App({
  api = defaultApi,
  realtime = defaultRealtime,
}: {
  api?: ObserverApi;
  realtime?: RealtimeClient;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [rooms, setRooms] = useState<RoomEntry[]>([]);
  const [contexts, setContexts] = useState<Record<string, OperatorRoomContext>>(
    {},
  );
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const lastApplied = useRef<Record<string, number>>({});
  const loadedRoomIds = useRef(new Set<string>());
  const selectedRoomRef = useRef<string | null>(selectedRoomId);
  selectedRoomRef.current = selectedRoomId;
  const seenEventIds = useRef(new Set<string>());
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        await api.bootstrap();
        const [sessionItems, roomItems] = await Promise.all([
          api.listSessions(),
          api.listRooms(),
        ]);
        if (!active) return;
        setSessions(sessionItems);
        setRooms(roomItems);
        const roomContexts = await Promise.all(
          roomItems.map(({ room }) => api.getRoomContext(room.id)),
        );
        if (!active) return;
        const nextContexts: Record<string, OperatorRoomContext> = {};
        for (const context of roomContexts) {
          nextContexts[context.room.id] = context;
          for (const event of context.events) {
            seenEventIds.current.add(event.id);
            lastApplied.current[event.roomId] = Math.max(
              lastApplied.current[event.roomId] ?? 0,
              event.sequence,
            );
          }
        }
        for (const roomId of Object.keys(nextContexts))
          loadedRoomIds.current.add(roomId);
        setContexts(nextContexts);
        setSelectedRoomId(
          (current) => current ?? roomItems[0]?.room.id ?? null,
        );
        setLoading(false);
      } catch (cause) {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not connect to the local hub.",
        );
        setLoading(false);
      }
    }
    void load();
    const presenceRefresh = setInterval(() => {
      void Promise.all([api.listSessions(), api.listRooms()])
        .then(async ([sessionItems, roomItems]) => {
          if (!active) return;
          setSessions(sessionItems);
          setRooms(roomItems);
          const newRooms = roomItems.filter(
            ({ room }) => !loadedRoomIds.current.has(room.id),
          );
          for (const { room } of newRooms) loadedRoomIds.current.add(room.id);
          await Promise.all(
            newRooms.map(async ({ room }) => {
              try {
                const context = await api.getRoomContext(room.id);
                if (!active) return;
                for (const event of context.events) {
                  seenEventIds.current.add(event.id);
                  lastApplied.current[event.roomId] = Math.max(
                    lastApplied.current[event.roomId] ?? 0,
                    event.sequence,
                  );
                }
                setContexts((previous) => ({
                  ...previous,
                  [room.id]: context,
                }));
                setSelectedRoomId((current) => current ?? room.id);
              } catch {
                loadedRoomIds.current.delete(room.id);
              }
            }),
          );
        })
        .catch(() => {});
    }, 5_000);
    return () => {
      active = false;
      clearInterval(presenceRefresh);
    };
  }, [api]);

  const addEvent = useCallback(
    (event: RoomEvent) => {
      setContexts((previous) => {
        const context = previous[event.roomId];
        if (!context || context.events.some((item) => item.id === event.id))
          return previous;
        const next = {
          ...context,
          events: [...context.events, event].sort(
            (a, b) => a.sequence - b.sequence,
          ),
        };
        return { ...previous, [event.roomId]: next };
      });
      if (selectedRoomRef.current !== event.roomId)
        setUnread((previous) => ({
          ...previous,
          [event.roomId]: (previous[event.roomId] ?? 0) + 1,
        }));
      if (
        event.type.startsWith("task_") ||
        event.type === "artifact_published" ||
        event.type === "member_joined" ||
        event.type === "room_closed"
      ) {
        void api
          .getRoomContext(event.roomId)
          .then((context) => {
            setContexts((previous) => ({
              ...previous,
              [event.roomId]: {
                ...context,
                events: mergeEvents(
                  context.events,
                  previous[event.roomId]?.events ?? [],
                ),
              },
            }));
            setRooms((previous) =>
              previous.map((item) =>
                item.room.id === context.room.id
                  ? { ...item, room: context.room }
                  : item,
              ),
            );
          })
          .catch(() => {});
        if (event.type === "member_joined")
          void api
            .listSessions()
            .then(setSessions)
            .catch(() => {});
      }
    },
    [api],
  );

  const processEvent = useCallback(
    async (event: RoomEvent): Promise<number> => {
      const current = lastApplied.current[event.roomId] ?? 0;
      if (seenEventIds.current.has(event.id) || event.sequence <= current)
        return current;
      const operation = queue.current.then(async () => {
        let cursor = lastApplied.current[event.roomId] ?? 0;
        if (event.sequence > cursor + 1) {
          let more = true;
          while (more && cursor < event.sequence - 1) {
            const repair = await api.listEvents(event.roomId, cursor);
            const ordered = repair
              .filter((item) => item.sequence > cursor)
              .sort((a, b) => a.sequence - b.sequence);
            if (!ordered.length) break;
            for (const item of ordered) {
              if (item.sequence > cursor + 1) break;
              if (!seenEventIds.current.has(item.id)) {
                seenEventIds.current.add(item.id);
                cursor = item.sequence;
                addEvent(item);
              }
            }
            more = ordered.length === 200;
          }
          if (event.sequence > cursor + 1)
            throw new Error("Room event gap could not be repaired yet.");
        }
        if (
          event.sequence === cursor + 1 &&
          !seenEventIds.current.has(event.id)
        ) {
          seenEventIds.current.add(event.id);
          cursor = event.sequence;
          addEvent(event);
        }
        lastApplied.current[event.roomId] = cursor;
      });
      queue.current = operation.then(
        () => undefined,
        () => undefined,
      );
      try {
        await operation;
        setError("");
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Room activity could not be recovered.",
        );
        throw cause;
      }
      return lastApplied.current[event.roomId] ?? current;
    },
    [api, addEvent],
  );

  const roomIds = useMemo(() => Object.keys(contexts), [contexts]);
  const initialCursors = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(contexts).map(([id, context]) => [
          id,
          Math.max(0, ...context.events.map((event) => event.sequence)),
        ]),
      ),
    [contexts],
  );
  const connection = useRoomStream({
    api,
    realtime,
    roomIds,
    initialCursors,
    onEvent: processEvent,
  });
  const selectedRoom = rooms.find(
    ({ room }) => room.id === selectedRoomId,
  )?.room;
  const context = selectedRoomId ? contexts[selectedRoomId] : undefined;
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const participantIds =
    context?.memberships
      .filter((membership) => membership.state === "active")
      .map((membership) => membership.sessionId) ?? [];
  const participants = participantIds
    .map((id) => sessionById.get(id))
    .filter((session): session is Session => Boolean(session));
  const events = context?.events ?? [];
  const decisions = events.filter((event) => event.type === "decision");

  async function sendMessage(text: string) {
    if (!selectedRoomId) return;
    const event = await api.postMessage(selectedRoomId, text);
    await processEvent(event);
  }
  function selectRoom(roomId: string) {
    setSelectedRoomId(roomId);
    setUnread((previous) => ({ ...previous, [roomId]: 0 }));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="Session Bus home">
          <span className="brand-mark">S</span>
          <span>
            session<span className="brand-light">bus</span>
          </span>
        </a>
        <div className="topbar-status" aria-live="polite">
          <span
            className={`stream-indicator ${connection === "connected" ? "is-connected" : ""}`}
            aria-hidden="true"
          />
          {stateLabel[connection]}
        </div>
        <span className="local-tag">
          <span aria-hidden="true">●</span> LOCAL
        </span>
      </header>
      <div className="workspace">
        <aside className="left-sidebar" aria-label="Workspace navigation">
          <SessionList sessions={sessions} />
          <RoomList
            rooms={rooms.map((entry) => entry.room)}
            selectedId={selectedRoomId}
            unread={unread}
            onSelect={selectRoom}
          />
          <div className="sidebar-footer">
            <span className="local-lock" aria-hidden="true">
              ⌑
            </span>
            <span>
              Local workspace
              <br />
              <small>Only this machine</small>
            </span>
          </div>
        </aside>
        <section className="main-stage" aria-label="Collaboration room">
          {loading ? (
            <div className="screen-state">
              <span className="loading-ring" />
              <h1>Connecting to Session Bus</h1>
              <p>Loading local sessions and rooms…</p>
            </div>
          ) : error && rooms.length === 0 ? (
            <div className="screen-state error-state">
              <span className="state-symbol">!</span>
              <h1>Hub connection failed</h1>
              <p>{error}</p>
              <button type="button" onClick={() => window.location.reload()}>
                Try again
              </button>
            </div>
          ) : selectedRoom && context ? (
            <RoomView
              room={selectedRoom}
              sessions={participants}
              events={events}
              tasks={context.tasks}
              decisions={decisions}
              artifacts={context.artifacts}
              connected={connection === "connected"}
              onSend={sendMessage}
            />
          ) : (
            <div className="screen-state empty-state">
              <span className="empty-icon" aria-hidden="true">
                ✦
              </span>
              <h1>Waiting for agents</h1>
              <p>
                When an agent creates a room, its collaboration will appear here
                in real time.
              </p>
              <div className="empty-step">
                <span>01</span>
                <span>Open your coding sessions with Session Bus enabled</span>
              </div>
              <div className="empty-step">
                <span>02</span>
                <span>Agents invite one another to collaborate</span>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function mergeEvents(
  primary: RoomEvent[],
  secondary: RoomEvent[],
): RoomEvent[] {
  const unique = new Map<string, RoomEvent>();
  for (const event of [...primary, ...secondary]) unique.set(event.id, event);
  return [...unique.values()].sort((a, b) => a.sequence - b.sequence);
}
