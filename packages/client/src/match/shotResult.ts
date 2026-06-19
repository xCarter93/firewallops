import type { TrajectoryPoint, Carve, Damage } from "@shared/sim";

/**
 * The shot-outcome contract — mirrors TECHNICAL-DESIGN §5.2 and RESEARCH
 * Pattern 1 EXACTLY.
 *
 * This is the Phase 3 swap-point payload: locally `MatchController.applyShot`
 * produces it from the frozen sim; in Phase 3 the server broadcasts an
 * identically-shaped `shotResult` message and the client's
 * `room.onMessage("shotResult", ...)` handler consumes it unchanged. Keeping
 * the shape byte-for-byte aligned with the server contract is what lets the
 * seam swap touch ONLY the `applyShot` method body.
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
