import type { RoomEvent } from "@session-bus/protocol";
import { useEffect, useRef, useState } from "react";
import type { ObserverApi, RealtimeClient } from "../types.js";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export function useRoomStream({
  api,
  realtime,
  roomIds,
  initialCursors,
  onEvent,
}: {
  api: ObserverApi;
  realtime: RealtimeClient;
  roomIds: string[];
  initialCursors: Record<string, number>;
  onEvent: (event: RoomEvent) => Promise<number>;
}) {
  const [state, setState] = useState<ConnectionState>("connecting");
  const cursorRef = useRef<Record<string, number>>({ ...initialCursors });
  const eventQueue = useRef(Promise.resolve());
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const roomKey = roomIds.slice().sort().join(",");

  useEffect(() => {
    for (const [roomId, sequence] of Object.entries(initialCursors)) {
      cursorRef.current[roomId] = Math.max(
        cursorRef.current[roomId] ?? 0,
        sequence,
      );
    }
  }, [initialCursors]);
  useEffect(() => {
    if (!roomKey) {
      setState("offline");
      return;
    }
    let stopped = false;
    let socket: { close(): void } | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    const connect = async () => {
      if (stopped) return;
      setState(retry === 0 ? "connecting" : "reconnecting");
      try {
        const ticket = await api.createWsTicket();
        if (stopped) return;
        socket = realtime.connect(
          ticket,
          { ...cursorRef.current },
          (event) => {
            const processing = eventQueue.current.then(async () => {
              cursorRef.current[event.roomId] = await handlerRef.current(event);
            });
            eventQueue.current = processing.catch(() => {
              socket?.close();
            });
            return processing;
          },
          () => {
            if (stopped) return;
            setState("connected");
            retry = 0;
          },
          () => {
            if (stopped) return;
            setState("reconnecting");
            retry = Math.min(retry + 1, 6);
            retryTimer = setTimeout(
              () => void connect(),
              Math.min(500 * 2 ** (retry - 1), 15_000),
            );
          },
        );
      } catch {
        if (stopped) return;
        setState("reconnecting");
        retry = Math.min(retry + 1, 6);
        retryTimer = setTimeout(
          () => void connect(),
          Math.min(500 * 2 ** (retry - 1), 15_000),
        );
      }
    };
    void connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [api, realtime, roomKey]);

  return state;
}
