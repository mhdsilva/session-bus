import type { RoomEvent } from "@session-bus/protocol";

export class SlowConsumerError extends Error {
  override readonly name = "SlowConsumerError";
  constructor() {
    super("event consumer exceeded its queue limit");
  }
}

export interface EventSubscription
  extends AsyncIterable<RoomEvent>,
    AsyncIterator<RoomEvent> {
  close(error?: Error): void;
}

interface Subscriber {
  sessionId: string;
  roomIds: Set<string>;
  queueLimit: number;
  queue: RoomEvent[];
  waiters: Array<{
    resolve: (result: IteratorResult<RoomEvent>) => void;
    reject: (error: Error) => void;
  }>;
  error?: Error;
  closed: boolean;
}

function matchesSessionEvent(sessionId: string, event: RoomEvent): boolean {
  if (event.type !== "member_invited" && event.type !== "member_joined")
    return false;
  return event.payload.sessionId === sessionId;
}

export class EventBroker {
  private readonly subscribers = new Set<Subscriber>();
  private readonly seenIds = new Set<string>();

  publish(event: RoomEvent): void {
    if (this.seenIds.has(event.id)) return;
    this.seenIds.add(event.id);
    if (this.seenIds.size > 10_000)
      this.seenIds.delete(this.seenIds.values().next().value as string);
    for (const subscriber of this.subscribers) {
      const targeted = matchesSessionEvent(subscriber.sessionId, event);
      if (!targeted && !subscriber.roomIds.has(event.roomId)) continue;
      if (event.type === "member_joined" && targeted)
        subscriber.roomIds.add(event.roomId);
      this.enqueue(subscriber, event);
      if (
        event.type === "member_left" &&
        event.senderId === subscriber.sessionId
      ) {
        subscriber.roomIds.delete(event.roomId);
      }
    }
  }

  subscribe(input: {
    sessionId: string;
    roomIds: Iterable<string>;
    queueLimit?: number;
  }): EventSubscription {
    const subscriber: Subscriber = {
      sessionId: input.sessionId,
      roomIds: new Set(input.roomIds),
      queueLimit: input.queueLimit ?? 256,
      queue: [],
      waiters: [],
      closed: false,
    };
    this.subscribers.add(subscriber);
    const broker = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<RoomEvent>> {
        const value = subscriber.queue.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (subscriber.error) return Promise.reject(subscriber.error);
        if (subscriber.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) =>
          subscriber.waiters.push({ resolve, reject }),
        );
      },
      async return(): Promise<IteratorResult<RoomEvent>> {
        this.close();
        return { value: undefined, done: true };
      },
      close(error?: Error) {
        if (subscriber.closed) return;
        subscriber.closed = true;
        subscriber.error = error;
        broker.subscribers.delete(subscriber);
        for (const waiter of subscriber.waiters.splice(0)) {
          if (error) waiter.reject(error);
          else waiter.resolve({ value: undefined, done: true });
        }
        subscriber.queue.length = 0;
      },
    };
  }

  private enqueue(subscriber: Subscriber, event: RoomEvent): void {
    if (subscriber.closed) return;
    const waiter = subscriber.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (subscriber.queue.length >= subscriber.queueLimit) {
      const error = new SlowConsumerError();
      subscriber.closed = true;
      subscriber.error = error;
      this.subscribers.delete(subscriber);
      for (const pending of subscriber.waiters.splice(0)) pending.reject(error);
      subscriber.queue.length = 0;
      return;
    }
    subscriber.queue.push(event);
  }
}
