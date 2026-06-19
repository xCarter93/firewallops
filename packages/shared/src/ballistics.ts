import type {
  FlightContext,
  FlightState,
  ProjectileDef,
  ShotInput,
  TrajectoryPoint,
} from "./types.js";
import type { TerrainMask } from "./terrain.js";
import { getBehavior } from "./projectile.js";

/**
 * Ballistics integrator (Phase 1, plan 03) — SIM-01.
 *
 * Fixed-step semi-implicit (symplectic) Euler at dt = 1/120. Every per-step
 * force is routed through the pluggable ProjectileBehavior hook
 * (`getBehavior(...).step`), NEVER a hardcoded default — that is the keystone
 * pluggability decision (RESEARCH anti-pattern: do not hardcode the default
 * into the integrator). TerrainMask is consulted ONLY through `isSolid` /
 * `outOfBounds`; collision authority lives in terrain.ts (it is imported here
 * as a TYPE for the signature, no value dependency).
 *
 * Purity (SIM-04): imports only from `./types`, `./terrain` (type), and
 * `./projectile`. No engine/network/DOM/math-library deps.
 *
 * Coordinate system: origin top-left, y screen-DOWN, x screen-RIGHT.
 * angleDeg 0 = right, 90 = up (sin is negated for "up" in y-down space).
 */

const DT = 1 / 120;

/** Degrees → radians (inlined; no math dependency). */
function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Map fired power (0..100) to a launch speed in px/s.
 *
 * Tuning constant (review concern #10 — Phase 2 needs this baseline): with
 * dt = 1/120 s, capping per-step displacement at ~2px caps speed at
 * 2 / (1/120) = 240 px/s. `POWER_TO_SPEED = 2.4` gives a 100-power shot
 * ≈ 240 px/s ≈ 2 px/step — small enough to not tunnel through a 1-2px terrain
 * column on the spike map. `def.powerScale` (the dimension-4 per-mech stat)
 * multiplies the base; Phase 1's default uses powerScale = 1.
 *
 * WORST CASE: power 100, powerScale 1 → 240 px/s → 2 px/step.
 */
const POWER_TO_SPEED = 2.4;

export function powerToSpeed(power: number, def?: ProjectileDef): number {
  const scale = def?.powerScale ?? 1;
  return power * POWER_TO_SPEED * scale;
}

export function simulateTrajectory(
  input: ShotInput,
  terrain: TerrainMask,
  maxSteps = 2000,
): { path: TrajectoryPoint[]; impact: TrajectoryPoint | null } {
  // Route forces through the pluggable hook (NOT hardcoded — the seam proof
  // test asserts the alternate diverges from the default).
  const behavior = getBehavior(input.projectile.behavior);

  const speed = powerToSpeed(input.power, input.projectile);
  let x = input.x;
  let y = input.y;
  let vx = Math.cos(rad(input.angleDeg)) * speed;
  let vy = -Math.sin(rad(input.angleDeg)) * speed; // y-down → negate sin for "up"

  const path: TrajectoryPoint[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const t = step * DT;
    const state: FlightState = { x, y, vx, vy };
    const ctx: FlightContext = {
      wind: input.wind,
      gravity: input.gravity,
      t,
      step,
    };

    const { fx, fy } = behavior.step(state, ctx, input.projectile);

    // Semi-implicit (symplectic) Euler: velocity BEFORE position.
    vx += fx * DT;
    vy += fy * DT;
    x += vx * DT;
    y += vy * DT;

    path.push({ x, y, t });

    if (terrain.isSolid(x, y) || terrain.outOfBounds(x, y)) {
      return { path, impact: { x, y, t } };
    }
  }

  // Flew off / timed out without a recorded impact.
  return { path, impact: null };
}
