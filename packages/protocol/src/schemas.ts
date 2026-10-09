import { z } from "zod/v4";

export const uuidSchema = z.uuid();

export const isoDateTimeSchema = z.iso.datetime();

export const absolutePathSchema = z
  .string()
  .refine(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
    "projectRoot must be absolute",
  );

export const sessionStatusSchema = z.enum([
  "available",
  "busy",
  "away",
  "offline",
]);

export const sessionProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  harness: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  projectRoot: absolutePathSchema,
  capabilities: z.array(z.string().trim().min(1)).max(32).default([]),
  currentFocus: z.string().max(500).default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const sessionSchema = sessionProfileSchema.extend({
  id: uuidSchema,
  status: sessionStatusSchema.default("available"),
  lastSeenAt: isoDateTimeSchema,
});

export const roomStatusSchema = z.enum(["open", "completed", "closed"]);

export const roomSchema = z.object({
  id: uuidSchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2000),
  status: roomStatusSchema.default("open"),
  createdBy: uuidSchema,
  createdAt: isoDateTimeSchema,
  contextSummary: z.string().max(5000).default(""),
});

export const membershipStateSchema = z.enum([
  "invited",
  "active",
  "declined",
  "left",
  "removed",
]);

export const membershipSchema = z.object({
  roomId: uuidSchema,
  sessionId: uuidSchema,
  state: membershipStateSchema,
  role: z.string().max(120).default(""),
  joinedAt: isoDateTimeSchema,
  lastReadSequence: z.int().nonnegative().default(0),
});

export const roomEventTypeSchema = z.enum([
  "message",
  "question",
  "decision",
  "task_created",
  "task_updated",
  "artifact_published",
  "conflict_reported",
  "member_invited",
  "member_joined",
  "member_left",
  "room_closed",
]);

export const roomEventSchema = z.object({
  id: uuidSchema,
  roomId: uuidSchema,
  sequence: z.int().positive(),
  senderId: uuidSchema,
  type: roomEventTypeSchema,
  version: z.literal(1),
  payload: z.record(z.string(), z.unknown()),
  replyToEventId: uuidSchema.optional(),
  taskId: uuidSchema.optional(),
  createdAt: z.iso.datetime(),
});

export const taskStatusSchema = z.enum([
  "open",
  "claimed",
  "blocked",
  "completed",
  "cancelled",
]);

export const sharedTaskSchema = z.object({
  id: uuidSchema,
  roomId: uuidSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(""),
  status: taskStatusSchema.default("open"),
  ownerSessionId: uuidSchema.optional(),
  resultSummary: z.string().max(5000).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const artifactKindSchema = z.enum([
  "file",
  "patch",
  "commit",
  "url",
  "text",
]);

export const artifactSchema = z.object({
  id: uuidSchema,
  roomId: uuidSchema,
  publisherSessionId: uuidSchema,
  kind: artifactKindSchema,
  uri: z.string().trim().min(1).max(4000),
  summary: z.string().max(2000).default(""),
  contentHash: z.string().max(256).optional(),
  createdAt: isoDateTimeSchema,
});

export const eventCursorSchema = z.object({
  roomId: uuidSchema,
  afterSequence: z.int().nonnegative(),
});

export const roomContextSchema = z.object({
  room: roomSchema,
  participants: z.array(sessionSchema),
  memberships: z.array(membershipSchema),
  decisions: z.array(roomEventSchema),
  tasks: z.array(sharedTaskSchema),
  artifacts: z.array(artifactSchema),
  recentEvents: z.array(roomEventSchema),
  nextCursor: eventCursorSchema,
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionProfile = z.infer<typeof sessionProfileSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type RoomStatus = z.infer<typeof roomStatusSchema>;
export type Room = z.infer<typeof roomSchema>;
export type MembershipState = z.infer<typeof membershipStateSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type RoomEventType = z.infer<typeof roomEventTypeSchema>;
export type RoomEvent = z.infer<typeof roomEventSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type SharedTask = z.infer<typeof sharedTaskSchema>;
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type EventCursor = z.infer<typeof eventCursorSchema>;
export type RoomContext = z.infer<typeof roomContextSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
