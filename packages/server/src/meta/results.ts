/**
 * Meta API stub — match-results write seam.
 *
 * v0 accepts and discards the payload (no-op). Real W/L persistence is Phase 5
 * (on Convex — the persistence layer that replaced Postgres); the seam exists,
 * not the logic. The HTTP write PATH is gated in routes.ts (service auth + Zod +
 * idempotency — review H7); this body stays a no-op stub.
 *
 * `resultId` is the idempotency key the route de-dups on (review H7); the
 * authoritative room passes a stable id when it records in-process.
 */

export interface MatchResultPayload {
  winnerTeam: number;
  resultId: string;
  mobiles?: unknown;
}

export function recordMatchResult(_payload: MatchResultPayload): void {
  /* no-op: accept + discard. Real W/L persistence is Phase 5 (on Convex). */
}
