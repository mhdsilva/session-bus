// @vitest-environment jsdom

import type { RoomEvent } from "@session-bus/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ObserverApi, RealtimeClient } from "../types.js";
import { useRoomStream } from "./use-room-stream.js";

afterEach(cleanup);

const event: RoomEvent = {
  id: "00000000-0000-4000-8000-000000000003",
  roomId: "00000000-0000-4000-8000-000000000002",
  sequence: 7,
  senderId: "00000000-0000-4000-8000-000000000001",
  type: "message",
  version: 1,
  payload: { text: "cursor check" },
  createdAt: "2026-10-09T10:00:00.000Z",
};
const api: ObserverApi = {
  bootstrap: async () => {},
  listSessions: async () => [],
  listRooms: async () => [],
  getRoomContext: async () => {
    throw new Error("unused");
  },
  listEvents: async () => [],
  createWsTicket: vi.fn(async () => "ticket"),
  postMessage: async () => event,
};

it("reconnects with the last applied cursor", async () => {
  const connections: Array<{
    cursors: Record<string, number>;
    onEvent: (event: RoomEvent) => Promise<void>;
    onClose: () => void;
  }> = [];
  const realtime: RealtimeClient = {
    connect: (_ticket, cursors, onEvent, onReady, onClose) => {
      connections.push({ cursors, onEvent, onClose });
      onReady();
      return { close() {} };
    },
  };
  const onEvent = vi.fn(async (received: RoomEvent) => received.sequence);
  const { result } = renderHook(() =>
    useRoomStream({
      api,
      realtime,
      roomIds: [event.roomId],
      initialCursors: { [event.roomId]: 6 },
      onEvent,
    }),
  );
  await waitFor(() => expect(connections).toHaveLength(1));
  await act(async () => {
    await connections[0]?.onEvent(event);
  });
  await waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
  act(() => connections[0]?.onClose());
  await waitFor(() => expect(connections).toHaveLength(2), { timeout: 3000 });
  expect(connections[1]?.cursors[event.roomId]).toBe(7);
  expect(result.current).toBe("connected");
});

it("drops the connection and retries when cursor repair fails", async () => {
  const connections: Array<{ onEvent: (event: RoomEvent) => Promise<void> }> =
    [];
  const realtime: RealtimeClient = {
    connect: (_ticket, _cursors, onEvent, onReady, onClose) => {
      connections.push({ onEvent });
      onReady();
      return { close: onClose };
    },
  };
  const onEvent = vi.fn(async () => {
    throw new Error("cursor repair unavailable");
  });
  const { result } = renderHook(() =>
    useRoomStream({
      api,
      realtime,
      roomIds: [event.roomId],
      initialCursors: { [event.roomId]: 6 },
      onEvent,
    }),
  );
  await waitFor(() => expect(result.current).toBe("connected"));
  await expect(connections[0]?.onEvent(event)).rejects.toThrow(
    "cursor repair unavailable",
  );
  await waitFor(() => expect(result.current).toBe("reconnecting"));
});
