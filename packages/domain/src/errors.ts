export type DomainErrorCode =
  | "AUTHENTICATION_FAILED"
  | "ROOM_NOT_FOUND"
  | "ROOM_MEMBERSHIP_REQUIRED"
  | "INVITATION_NOT_ACCEPTED"
  | "INVALID_TRANSITION"
  | "ROOM_CLOSED"
  | "IDEMPOTENCY_CONFLICT";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
