import { type SharedTask, sharedTaskSchema } from "@session-bus/protocol";
import { DomainError } from "./errors.js";
import {
  appendEvent,
  authenticateCaller,
  type CollaborationDeps,
  requireActiveMembership,
} from "./events.js";

/**
 * Shared task use cases. Transitions are:
 *
 *   open    -> claimed | cancelled
 *   claimed -> blocked | completed | cancelled
 *   blocked -> claimed | cancelled
 *
 * `completed` and `cancelled` are terminal. Any active member may create
 * or claim a task and may cancel a task that is not currently owned;
 * only the owner may change a claimed task.
 */

export type UpdateTaskStatus = "blocked" | "completed" | "cancelled";

export interface CreateTaskInput {
  roomId: string;
  title: string;
  description?: string;
  idempotencyKey: string;
}

export interface ClaimTaskInput {
  taskId: string;
  idempotencyKey: string;
}

export interface UpdateTaskInput {
  taskId: string;
  status: UpdateTaskStatus;
  resultSummary?: string;
  idempotencyKey: string;
}

interface CreateTaskIdempotencyRecord {
  roomId: string;
  title: string;
  description: string;
  task: SharedTask;
}

interface ClaimTaskIdempotencyRecord {
  taskId: string;
  task: SharedTask;
}

interface TaskIdempotencyRecord {
  taskId: string;
  status: UpdateTaskStatus;
  resultSummary?: string;
  task: SharedTask;
}

function requireTaskTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "task title must be a non-empty string of at most 200 characters",
    );
  }
  return trimmed;
}

function requireTaskDescription(description: string | undefined): string {
  const trimmed = description?.trim() ?? "";
  if (trimmed.length > 2000) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "task description must be at most 2000 characters",
    );
  }
  return trimmed;
}

export async function createTask(
  deps: CollaborationDeps,
  authToken: string,
  input: CreateTaskInput,
): Promise<SharedTask> {
  const title = requireTaskTitle(input.title);
  const description = requireTaskDescription(input.description);
  return deps.db.write(async (uow) => {
    const caller = await authenticateCaller(uow, authToken);
    const room = await uow.rooms.findById(input.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${input.roomId} does not exist`,
      );
    }
    const key = `room:task:create:${room.id}:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as CreateTaskIdempotencyRecord | null;
    if (existing) {
      if (existing.title !== title || existing.description !== description) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used with a different task",
        );
      }
      return existing.task;
    }
    const membership = await uow.rooms.findMembership(room.id, caller.id);
    requireActiveMembership(membership, room, { requireOpen: true });
    const now = deps.clock.now().toISOString();
    const task = sharedTaskSchema.parse({
      id: deps.ids.next(),
      roomId: room.id,
      title,
      description,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    await uow.tasks.insert(task);
    await appendEvent(deps, uow, {
      roomId: room.id,
      senderId: caller.id,
      type: "task_created",
      payload: { task },
      taskId: task.id,
    });
    await uow.idempotency.save(key, {
      roomId: room.id,
      title,
      description,
      task,
    });
    return task;
  });
}

export async function claimTask(
  deps: CollaborationDeps,
  authToken: string,
  input: ClaimTaskInput,
): Promise<SharedTask> {
  return deps.db.write(async (uow) => {
    const caller = await authenticateCaller(uow, authToken);
    const task = await uow.tasks.findById(input.taskId);
    if (!task) {
      throw new DomainError(
        "TASK_NOT_FOUND",
        `task ${input.taskId} does not exist`,
      );
    }
    const room = await uow.rooms.findById(task.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${task.roomId} does not exist`,
      );
    }
    const key = `task:claim:${task.id}:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as ClaimTaskIdempotencyRecord | null;
    if (existing) {
      return existing.task;
    }
    const membership = await uow.rooms.findMembership(room.id, caller.id);
    requireActiveMembership(membership, room, { requireOpen: true });
    if (task.status !== "open" && task.status !== "blocked") {
      throw new DomainError(
        "INVALID_TRANSITION",
        `cannot claim a task in state ${task.status}`,
      );
    }
    const claimed = sharedTaskSchema.parse({
      ...task,
      status: "claimed",
      ownerSessionId: caller.id,
      updatedAt: deps.clock.now().toISOString(),
    });
    await uow.tasks.update(claimed);
    await appendEvent(deps, uow, {
      roomId: room.id,
      senderId: caller.id,
      type: "task_updated",
      payload: { task: claimed },
      taskId: claimed.id,
    });
    await uow.idempotency.save(key, {
      taskId: task.id,
      task: claimed,
    } satisfies ClaimTaskIdempotencyRecord);
    return claimed;
  });
}

function assertTransition(
  task: SharedTask,
  callerId: string,
  target: UpdateTaskStatus,
): void {
  if (task.status === "completed" || task.status === "cancelled") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `task ${task.id} is terminal (${task.status})`,
    );
  }
  if (task.status === "claimed") {
    if (task.ownerSessionId !== callerId) {
      throw new DomainError(
        "INVALID_TRANSITION",
        "only the task owner may change a claimed task",
      );
    }
    return;
  }
  if (task.status === "open" || task.status === "blocked") {
    if (target !== "cancelled") {
      throw new DomainError(
        "INVALID_TRANSITION",
        `cannot move a ${task.status} task to ${target}`,
      );
    }
    return;
  }
  throw new DomainError(
    "INVALID_TRANSITION",
    `cannot update a task in state ${task.status}`,
  );
}

export async function updateTask(
  deps: CollaborationDeps,
  authToken: string,
  input: UpdateTaskInput,
): Promise<SharedTask> {
  if (
    input.status !== "blocked" &&
    input.status !== "completed" &&
    input.status !== "cancelled"
  ) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      `unsupported task status ${String(input.status)}`,
    );
  }
  const resultSummary = input.resultSummary?.trim();
  if (resultSummary !== undefined && resultSummary.length > 5000) {
    throw new DomainError(
      "INVALID_PAYLOAD",
      "task result summary must be at most 5000 characters",
    );
  }
  return deps.db.write(async (uow) => {
    const caller = await authenticateCaller(uow, authToken);
    const task = await uow.tasks.findById(input.taskId);
    if (!task) {
      throw new DomainError(
        "TASK_NOT_FOUND",
        `task ${input.taskId} does not exist`,
      );
    }
    const room = await uow.rooms.findById(task.roomId);
    if (!room) {
      throw new DomainError(
        "ROOM_NOT_FOUND",
        `room ${task.roomId} does not exist`,
      );
    }
    const key = `task:update:${task.id}:${caller.id}:${input.idempotencyKey}`;
    const existing = (await uow.idempotency.find(
      key,
    )) as TaskIdempotencyRecord | null;
    if (existing) {
      if (
        existing.status !== input.status ||
        existing.resultSummary !== resultSummary
      ) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used with a different task update",
        );
      }
      return existing.task;
    }
    const membership = await uow.rooms.findMembership(room.id, caller.id);
    requireActiveMembership(membership, room, { requireOpen: true });
    assertTransition(task, caller.id, input.status);
    const updated = sharedTaskSchema.parse({
      ...task,
      status: input.status,
      resultSummary: resultSummary ?? task.resultSummary,
      updatedAt: deps.clock.now().toISOString(),
    });
    await uow.tasks.update(updated);
    await appendEvent(deps, uow, {
      roomId: room.id,
      senderId: caller.id,
      type: "task_updated",
      payload: { task: updated },
      taskId: updated.id,
    });
    await uow.idempotency.save(key, {
      taskId: task.id,
      status: input.status,
      resultSummary,
      task: updated,
    } satisfies TaskIdempotencyRecord);
    return updated;
  });
}
