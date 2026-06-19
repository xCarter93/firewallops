import type { Carve, Damage, Mech, ProjectileDef, ShotInput } from "./types.js";
import type { TerrainMask } from "./terrain.js";
import { quantizeCarve } from "./terrain.js";
import { getBehavior } from "./projectile.js";
import { simulateTrajectory } from "./ballistics.js";

/**
 * Blast resolver (Phase 1, plan 04) — SIM-03.
 *
 * Ties the phase together: expand a fired shot through the behavior's
 * `createSubShots` spawn seam, run each trajectory, quantize every float impact
 * via the SHARED `quantizeCarve` helper (the single float→int boundary, plan
 * 02), carve the crater, guard out-of-bounds impacts, and compute per-mech
 * distance-scaled damage. Returns `carves[]`/`damage[]` arrays so multi-impact
 * is the native shape from day one.
 *
 * Purity (SIM-04): imports only from `./types`, `./terrain`, `./projectile`,
 * `./ballistics`. No engine/network/DOM deps.
 */

/**
 * Per-mech blast damage at a given distance from the blast center.
 *
 * ALL anchors are read from the ProjectileDef (RESEARCH Pattern 3 — never
 * globals), so different mechs/items can differ without a sim-core rewrite:
 * - linear falloff: `maxDamage * (1 - dist / blastRadius)`
 * - graze floor: any in-radius hit deals at least `grazeFloor`
 * - direct-hit bonus: a hit within `directHitThreshold` px adds `directHitBonus`
 *   ON TOP of the falloff peak.
 *
 * Outside `blastRadius` (inclusive) damage is 0.
 */
export function blastDamage(dist: number, def: ProjectileDef): number {
  if (dist >= def.blastRadius) return 0;
  let dmg = def.maxDamage * (1 - dist / def.blastRadius); // linear falloff
  dmg = Math.max(dmg, def.grazeFloor); // a graze always counts
  if (dist <= def.directHitThreshold) dmg += def.directHitBonus; // pinpoint bonus
  return dmg;
}

/**
 * Resolve a fired shot into terrain carves + per-mech damage.
 *
 * MUTATES `terrain` in place (it carves the crater into the passed mask). This
 * is the authoritative server-side mask in Phase 3. Callers needing a
 * before/after preview (Phase 2) MUST clone the mask first.
 *
 * Returns ARRAYS (`carves[]`/`damage[]`) so multi-impact is the native shape:
 * resolveShot loops over the behavior's `createSubShots` (Phase 1 default
 * yields exactly one sub-shot) and accumulates carves/damage across all of
 * them, then merges per-mech damage through the behavior's `combineDamage`.
 *
 * The `def` parameter is the same ProjectileDef carried on `input.projectile`
 * (the plan-01 contract passes it explicitly); each sub-shot's own
 * `sub.projectile` is used for its impact resolution so a future spread mech
 * can vary sub-shot defs.
 *
 * Each float impact is quantized ONCE via the shared `quantizeCarve` helper, and
 * the SAME integers are both recorded in `carves[]` and passed into
 * `carveCircle` — so `carves[0]` replays byte-identically on a fresh clone (the
 * Phase 3 server-broadcast-integer / client-replay-integer parity contract).
 *
 * An out-of-bounds or off-screen impact contributes NO carve and NO damage —
 * that sub-shot is skipped.
 */
export function resolveShot(
  input: ShotInput,
  terrain: TerrainMask,
  mechs: Mech[],
  _def: ProjectileDef,
): { carves: Carve[]; damage: Damage[] } {
  const behavior = getBehavior(input.projectile.behavior);

  // Expand through the spawn seam (loop, don't just array-shape the return).
  // Phase 1 default returns `[input]`.
  const subShots = behavior.createSubShots(input, input.projectile);
  if (subShots.length === 0) return { carves: [], damage: [] };

  const carves: Carve[] = [];
  const perImpactDamage: Damage[][] = [];

  for (const sub of subShots) {
    const { impact } = simulateTrajectory(sub, terrain);

    // Flew off / timed out: no impact to resolve.
    if (impact === null) continue;

    // OOB guard: an off-map crater center carves nothing useful and would
    // compute damage relative to a point no mech can be near — skip it.
    if (terrain.outOfBounds(impact.x, impact.y)) continue;

    // Quantize ONCE via the shared helper so the recorded carve and the carved
    // mask come from the exact same integers (the parity guarantee). NOTE:
    // blastRadius doubles as the crater radius for the spike — gameplay blast
    // radius and terrain destruction radius are intentionally coupled in Phase
    // 1. If Phase 2 needs them decoupled, add a `craterRadius` field to
    // ProjectileDef then.
    const carve = quantizeCarve(impact.x, impact.y, sub.projectile.blastRadius);
    terrain.carveCircle(carve.cx, carve.cy, carve.r);
    carves.push(carve);

    // Distance-scaled per-mech damage, measured from the QUANTIZED carve center
    // (the same integer the carve used) so damage tracks the actual crater.
    const damageForImpact: Damage[] = [];
    for (const mech of mechs) {
      const dist = Math.hypot(mech.x - carve.cx, mech.y - carve.cy);
      const amount = blastDamage(dist, sub.projectile);
      // Include ONLY mechs that take damage so the array stays tight (the
      // documented contract; the SIM-03 tests match it).
      if (amount > 0) damageForImpact.push({ mechId: mech.id, amount });
    }
    perImpactDamage.push(damageForImpact);
  }

  // Merge via the behavior (single-impact passes through; multi-impact merges
  // per-mech). If no sub-shot landed in-bounds, this yields an empty array.
  const damage = behavior.combineDamage(perImpactDamage, input.projectile);

  return { carves, damage };
}
