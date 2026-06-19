/**
 * @shared/sim public API barrel.
 *
 * package.json `main`/`types`/`exports` point at this file, so `@shared/sim`
 * must be resolvable from plan 01 onward. This EARLY barrel is finalized in
 * plan 04 (confirmed against the real implementations).
 *
 * NOTE: intra-package code uses RELATIVE imports (`./types`, `./terrain`, …).
 * Only outside consumers (the harness in Phase 1, the client/server later)
 * import from `@shared/sim`.
 */

// Public types (the Phase 2/3 contract).
export type {
  ShotInput,
  TrajectoryPoint,
  ProjectileDef,
  MapDef,
  Carve,
  Damage,
  Mech,
  FlightState,
  FlightContext,
  ProjectileBehavior,
} from "./types.js";

// Runtime symbols (stubbed in plan 01; real impls land in plans 02/04).
export { TerrainMask, quantizeCarve } from "./terrain.js";
export { simulateTrajectory, powerToSpeed } from "./ballistics.js";
export { DEFAULT_BEHAVIOR, getBehavior } from "./projectile.js";
export { resolveShot, blastDamage } from "./resolve.js";
