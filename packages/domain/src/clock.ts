/**
 * Deterministic wall-clock port. Production uses the system clock;
 * tests inject a manually advanced clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
