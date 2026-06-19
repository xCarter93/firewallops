import type {
  Damage,
  FlightContext,
  FlightState,
  ProjectileBehavior,
  ProjectileDef,
  ShotInput,
} from "./types.js";

/**
 * The pluggable projectile-behavior registry (Phase 1, plan 03).
 *
 * Per CONTEXT "build the seam, not the content": Phase 1 ships exactly ONE
 * default ballistic behavior for v0 play, plus ONE alternate (wind-coupled)
 * behavior that exists purely as a FIXTURE to PROVE the seam is real — the
 * integrator routes every per-step force through `getBehavior(...).step`, so
 * the default is never hardcoded into `simulateTrajectory`. The deferred
 * Gunbound mech roster (Boomerang/Dino/Turtle → MECH-01, v2) slots in later as
 * additional registry entries with no sim-core rewrite.
 *
 * Purity (SIM-04): imports ONLY from `./types`. No engine/network/DOM/RNG deps.
 */

/**
 * Sum per-impact damage by `mechId` across sub-impacts (dimension 3).
 *
 * Phase 1's single-impact default passes the lone impact list through
 * unchanged; with multiple sub-impacts (a future spread mech) the per-mech
 * amounts add up. Shared by both Phase 1 behaviors.
 */
function sumPerMech(perImpact: Damage[][], _def: ProjectileDef): Damage[] {
  const totals = new Map<string, number>();
  for (const impact of perImpact) {
    for (const d of impact) {
      totals.set(d.mechId, (totals.get(d.mechId) ?? 0) + d.amount);
    }
  }
  return [...totals].map(([mechId, amount]) => ({ mechId, amount }));
}

/** Single-shot passthrough — the multi-projectile spawn seam (dimension 2). */
function singleShot(input: ShotInput, _def: ProjectileDef): ShotInput[] {
  // Phase 1 ships only single-shot; a real spread/fork mech is deferred to
  // MECH-01 (v2). `resolveShot` (plan 04) loops over this array so multi-impact
  // is native through the seam, not merely the return shape.
  return [input];
}

/**
 * The one default ballistic projectile for v0 play.
 *
 * `step` returns plain ballistics: wind as a signed horizontal accel and
 * gravity downward (y is screen-down). It goes through the SAME hook the
 * alternate uses — the integrator must NOT special-case it.
 *
 * RESERVED: `def.mass` and `def.drag` are intentionally NOT consumed here. The
 * default treats the projectile as unit-mass and drag-free; real mass/drag
 * flight tuning is deferred to MECH-01 (v2). The fields live on the def (the
 * dimension-4 per-mech-stats seam) but no Phase 1 behavior reads them.
 */
export const DEFAULT_BEHAVIOR: ProjectileBehavior = {
  step(_state: FlightState, ctx: FlightContext, _def: ProjectileDef) {
    return { fx: ctx.wind, fy: ctx.gravity };
  },
  createSubShots: singleShot,
  combineDamage: sumPerMech,
};

/** Tuning of the wind-coupled proof fixture — NOT balance, just enough coupling
 * to make the produced path measurably diverge from the default. */
const WIND_COUPLE = 0.5;

/**
 * The single alternate behavior — a FIXTURE, not a balanced mech.
 *
 * Inspired by the Gunbound "Boomerang" riding the wind (CONTEXT Specific
 * Ideas). Its `step` couples the horizontal force to the projectile's own
 * velocity direction, so for identical kinematics its path measurably DIFFERS
 * from the default. This is the seam proof: if the integrator were hardcoded to
 * the default, the windCoupled path would be identical — and the seam-proof
 * test would (rightly) fail CI.
 */
export const WIND_COUPLED_BEHAVIOR: ProjectileBehavior = {
  step(state: FlightState, ctx: FlightContext, _def: ProjectileDef) {
    // Velocity-dependent horizontal force: the wind's effect is amplified in
    // the direction of travel (a crude "ride the wind" lift). Math.sign(0) === 0
    // so a purely vertical shot still behaves, just without the coupling term.
    const fx = ctx.wind * (1 + WIND_COUPLE * Math.sign(state.vx));
    return { fx, fy: ctx.gravity };
  },
  createSubShots: singleShot,
  combineDamage: sumPerMech,
};

const BEHAVIORS: Record<string, ProjectileBehavior> = {
  default: DEFAULT_BEHAVIOR,
  windCoupled: WIND_COUPLED_BEHAVIOR,
};

/**
 * Resolve a behavior key to its registered strategy object. An unknown key
 * falls back to the default ballistic behavior (`?? DEFAULT_BEHAVIOR`) so a bad
 * def reference can never crash the integrator.
 */
export function getBehavior(key: string): ProjectileBehavior {
  return BEHAVIORS[key] ?? DEFAULT_BEHAVIOR;
}
