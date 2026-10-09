// @vitest-environment jsdom

import type { RoomEvent } from "@session-bus/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./app.js";
import type { ObserverApi, RealtimeClient } from "./types.js";

const session = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "codex",
  harness: { name: "codex", version: "1" },
  projectRoot: "/repo",
  capabilities: [],
  currentFocus: "auth",
  metadata: {},
  status: "available" as const,
  lastSeenAt: "2026-10-09T10:00:00.000Z",
};
const room = {
  id: "00000000-0000-4000-8000-000000000002",
  title: "Ship auth",
  objective: "Implement authentication",
  status: "open" as const,
  createdBy: session.id,
  createdAt: "2026-10-09T10:00:00.000Z",
  contextSummary: "",
};
const fakeApi: ObserverApi = {
  bootstrap: async () => {},
  listSessions: async () => [session],
  listRooms: async () => [{ room, memberships: [] }],
  getRoomContext: async () => ({
    room,
    memberships: [],
    events: [],
    tasks: [],
    artifacts: [],
  }),
  listEvents: async () => [],
  createWsTicket: async () => "ticket",
  postMessage: async () => messageEvent("Human reply"),
};
const createFakeRealtime = () => {
  let emit = async (_event: RoomEvent) => {};
  const realtime: RealtimeClient = {
    connect: (_ticket, _cursors, onEvent, onReady) => {
      emit = onEvent;
      onReady();
      return { close() {} };
    },
  };
  return {
    realtime,
    emit: (event: RoomEvent) => {
      void emit(event);
    },
  };
};
const messageEvent = (text: string) => ({
  id: "00000000-0000-4000-8000-000000000003",
  roomId: room.id,
  sequence: 1,
  senderId: session.id,
  type: "message" as const,
  version: 1 as const,
  payload: { text },
  createdAt: "2026-10-09T10:01:00.000Z",
});

afterEach(cleanup);

describe("observer app", () => {
  it("shows a new agent message without refreshing", async () => {
    const fake = createFakeRealtime();
    render(<App api={fakeApi} realtime={fake.realtime} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /ship auth/i }),
    );
    act(() => fake.emit(messageEvent("Schema review complete")));
    expect(await screen.findByText("Schema review complete")).toBeTruthy();
  });
});

it("repairs a missing sequence and ignores duplicate live events", async () => {
  const fake = createFakeRealtime();
  const missing = {
    ...messageEvent("Sequence two recovered"),
    id: "00000000-0000-4000-8000-000000000004",
    sequence: 2,
  };
  const third = {
    ...messageEvent("Sequence three live"),
    id: "00000000-0000-4000-8000-000000000005",
    sequence: 3,
  };
  const api: ObserverApi = {
    ...fakeApi,
    getRoomContext: async () => ({
      room,
      memberships: [],
      events: [messageEvent("Sequence one")],
      tasks: [],
      artifacts: [],
    }),
    listEvents: async () => [missing],
  };
  render(<App api={api} realtime={fake.realtime} />);
  await screen.findByText("Sequence one");
  act(() => fake.emit(third));
  expect(
    await screen.findByText("Sequence two recovered", {}, { timeout: 5000 }),
  ).toBeTruthy();
  expect(
    await screen.findByText("Sequence three live", {}, { timeout: 5000 }),
  ).toBeTruthy();
  act(() => fake.emit(third));
  expect(screen.getAllByText("Sequence three live")).toHaveLength(1);
});

it("shows offline sessions and provides an accessible empty room state", async () => {
  const offline = { ...session, status: "offline" as const, currentFocus: "" };
  const api: ObserverApi = {
    ...fakeApi,
    listSessions: async () => [offline],
    listRooms: async () => [],
  };
  render(<App api={api} realtime={createFakeRealtime().realtime} />);
  expect(await screen.findByText("Waiting for agents")).toBeTruthy();
  expect(screen.getByText(/codex.*offline/)).toBeTruthy();
  expect(
    screen.getByRole("navigation", { name: "Collaboration rooms" }),
  ).toBeTruthy();
});

it("disables the composer for a closed room and supports keyboard room selection", async () => {
  const user = userEvent.setup();
  const closedRoom = { ...room, status: "closed" as const };
  const api: ObserverApi = {
    ...fakeApi,
    listRooms: async () => [{ room: closedRoom, memberships: [] }],
    getRoomContext: async () => ({
      room: closedRoom,
      memberships: [],
      events: [],
      tasks: [],
      artifacts: [],
    }),
  };
  render(<App api={api} realtime={createFakeRealtime().realtime} />);
  const roomButton = await screen.findByRole("button", { name: /ship auth/i });
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("link", { name: "Session Bus home" }),
  );
  await user.tab();
  expect(document.activeElement).toBe(roomButton);
  await user.keyboard("{Enter}");
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Message the room",
      })) as HTMLTextAreaElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
