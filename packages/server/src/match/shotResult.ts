import type { TrajectoryPoint, Carve, Damage } from "@shared/sim";

/**
 * The shot-outcome contract — a BYTE-IDENTICAL copy of
 * packages/client/src/match/shotResult.ts.
 *
 * This is the `broadcast("shotResult", result)` payload shape. The server
 * builds it (runServerShot) and the client consumes it unchanged via
 * `room.onMessage("shotResult", ...)`. It is copied here rather than imported
 * from the client to avoid a server→client package dependency; the shape is
 * frozen + tiny, and the golden parity test (parity.test.ts) guards the
 * OUTCOME, while this copy guards the structural shape.
 *
 * IF YOU EDIT THIS, edit packages/client/src/match/shotResult.ts to match — the
 * two MUST stay aligned or the seam swap (client applyShot ↔ server shotResult)
 * silently diverges.
 */
export interface ShotResult {
  /** The visible primary arc (the first sub-shot's flight path). */
  path: TrajectoryPoint[];
  /** Where the primary arc landed, or null if it flew off / timed out. */
  impact: TrajectoryPoint | null;
  /** Every quantized crater carved by the shot (one per landed sub-shot). */
  carves: Carve[];
  /** Per-mech damage, summed across all sub-impacts. */
  damage: Damage[];
}
