import type {
  Artifact,
  Membership,
  Room,
  RoomEvent,
  Session,
  SharedTask,
} from "@session-bus/protocol";

export interface OperatorRoomContext {
  room: Room;
  memberships: Membership[];
  events: RoomEvent[];
  tasks: SharedTask[];
  artifacts: Artifact[];
}
export interface ObserverApi {
  bootstrap(): Promise<void>;
  listSessions(): Promise<Session[]>;
  listRooms(): Promise<Array<{ room: Room; memberships: Membership[] }>>;
  getRoomContext(roomId: string): Promise<OperatorRoomContext>;
  listEvents(roomId: string, after: number): Promise<RoomEvent[]>;
  createWsTicket(): Promise<string>;
  postMessage(roomId: string, text: string): Promise<RoomEvent>;
}
export interface RealtimeClient {
  connect(
    ticket: string,
    afterByRoom: Record<string, number>,
    onEvent: (event: RoomEvent) => Promise<void>,
    onReady: () => void,
    onClose: () => void,
  ): { close(): void };
}
