/**
 * Meta API stub — match-results write seam.
 *
 * v0 accepts and discards the payload (200 no-op). Real W/L persistence is
 * Phase 5 (Postgres lands Phase 4); the seam exists, not the logic. The shape
 * is intentionally loose — real validation is Phase 5.
 */

export interface MatchResultPayload {
  winnerTeam: number;
  mobiles?: unknown;
}

export function recordMatchResult(_payload: MatchResultPayload): void {
  /* no-op: accept + discard. Real W/L persistence is Phase 5 (Postgres lands Phase 4). */
}
