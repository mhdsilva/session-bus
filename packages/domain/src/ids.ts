import { randomUUID } from "node:crypto";

/**
 * Deterministic id port. Production generates random UUIDs;
 * tests inject a counter so ids are stable across runs.
 */
export interface IdGenerator {
  next(): string;
}

export const randomIdGenerator: IdGenerator = {
  next: () => randomUUID(),
};
