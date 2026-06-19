import type { ShotInput, TrajectoryPoint } from "./types.js";
import type { TerrainMask } from "./terrain.js";

/**
 * THROW-STUB (Phase 1, plan 01). Real implementation lands in plan 02.
 *
 * Fixed-step semi-implicit Euler integrator (dt = 1/120). Routes per-step forces
 * through the projectile's flight-behavior hook (never a hardcoded default), so
 * the pluggable seam is exercised by both the default and alternate behaviors.
 */
export function simulateTrajectory(
  _input: ShotInput,
  _terrain: TerrainMask,
  _maxSteps = 2000,
): { path: TrajectoryPoint[]; impact: TrajectoryPoint | null } {
  throw new Error("simulateTrajectory not implemented");
}

/** Scale fired power (+ the def's powerScale) into a launch speed. */
export function powerToSpeed(_power: number, _powerScale: number): number {
  throw new Error("powerToSpeed not implemented");
}
