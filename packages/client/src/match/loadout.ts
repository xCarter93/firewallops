import type { ProjectileDef, ShotInput } from "@shared/sim";

/**
 * Data-driven 1 / 2 / Trojan loadout (Phase 2, plan 02) — PLAY-04.
 *
 * Every lethality and physics scalar lives on the ProjectileDef (never a
 * global), mirroring the @shared/sim contract. All three defs use
 * `behavior: "default"` (the frozen ballistic step). Shot 2's fork is achieved
 * CLIENT-SIDE via {@link expandFork} — research A1: the sim's `BEHAVIORS`
 * registry is private with no public `registerBehavior`, so the client cannot
 * add a spread behavior into the sim. Instead the loadout declares
 * `spread`/`subProjectileCount` on the def and the MatchController fans the
 * shot into N sub-shots, calling `resolveShot` once per sub-shot.
 *
 * Tuning anchors (Phase 1 lethality bands, dead-center = falloff peak + direct
 * bonus):
 *   - SHOT_1 single packet: 30 + 18 = 48 HP (inside the 25-50 anchor)
 *   - SHOT_2 forked: 14 + 8 = 22 HP per sub (3 weaker craters, not a triple-stack)
 *   - TROJAN finisher: 38 + 14 = 52 HP (heaviest single strike, large blast)
 *
 * @shared/sim is NOT imported as a value here and is NOT modified.
 */

/** The three selectable shot ids (HUD labels: SHOT 1 / SHOT 2 / TROJAN). */
export type ShotId = "shot-1" | "shot-2" | "trojan";

/** "Single packet" — the harness default-shell basis. dead-center = 48 HP. */
export const SHOT_1: ProjectileDef = {
  id: "shot-1",
  behavior: "default",
  maxDamage: 30,
  // Tuning (02-04 fun-gate): blastRadius is ALSO the crater radius. 60 cratered
  // ~half the terrain band depth (too deep on a miss); 36 reads as a shallow
  // bowl. Dead-center damage is unchanged (independent of blastRadius); the blast
  // falloff just tightens, rewarding accuracy.
  blastRadius: 36,
  grazeFloor: 5,
  directHitThreshold: 6,
  directHitBonus: 18,
  // Tuning pass (02-04 NO-GO fix 3): base 2.4 × 2 → ~480px/s launch so a full-
  // power shot comfortably crosses the ~720px gap on the 1024-wide map. ~4px/step
  // at the sim's dt=1/120 — still tunneling-safe against solid ground.
  powerScale: 2,
  mass: 1,
  drag: 0,
  turnDelay: 10,
};

/**
 * "Forked exploit" — fans into 3 weaker sub-shots client-side. Each sub
 * dead-center = 22 HP, so three craters spread damage rather than stacking.
 */
export const SHOT_2: ProjectileDef = {
  id: "shot-2",
  behavior: "default",
  maxDamage: 14,
  // Tuning (02-04 fun-gate): smaller per-sub craters (3 of them); was 44.
  blastRadius: 28,
  grazeFloor: 3,
  directHitThreshold: 6,
  directHitBonus: 8,
  // Tuning pass (02-04 NO-GO fix 3): ~2× launch velocity to cross the map gap.
  powerScale: 2,
  mass: 1,
  drag: 0,
  spread: 16,
  subProjectileCount: 3,
  turnDelay: 22,
};

/** "Heavy finisher" — heaviest single strike + large blast. dead-center = 52 HP. */
export const TROJAN: ProjectileDef = {
  id: "trojan",
  behavior: "default",
  maxDamage: 38,
  // Tuning (02-04 fun-gate): still the biggest crater, but shallower; was 90.
  // Stays > SHOT_1.blastRadius (the loadout test asserts this ordering).
  blastRadius: 56,
  grazeFloor: 8,
  directHitThreshold: 8,
  directHitBonus: 14,
  // Tuning pass (02-04 NO-GO fix 3): ~2× launch velocity to cross the map gap.
  powerScale: 2,
  mass: 1,
  drag: 0,
  turnDelay: 40,
};

/** Registry keyed by ShotId so the Scene (plan 04) selects by id. */
export const LOADOUT: Record<ShotId, ProjectileDef> = {
  "shot-1": SHOT_1,
  "shot-2": SHOT_2,
  trojan: TROJAN,
};

/**
 * Expand one fired aim into its sub-shots (the CLIENT-SIDE fork — research A1).
 *
 * A def with `subProjectileCount <= 1` (or undefined) returns the single aim
 * unchanged. Otherwise it returns `n` copies whose `angleDeg` is fanned
 * symmetrically about the input angle by `spread` total degrees:
 * `angleDeg = aim.angleDeg + (i - (n-1)/2) * (spread / (n-1))`. Each copy keeps
 * the same projectile def so `resolveShot` uses the per-sub blast anchors.
 */
export function expandFork(aim: ShotInput, def: ProjectileDef): ShotInput[] {
  const n = def.subProjectileCount ?? 1;
  if (n <= 1) return [aim];

  const spread = def.spread ?? 0;
  const step = spread / (n - 1);
  const mid = (n - 1) / 2;

  const subs: ShotInput[] = [];
  for (let i = 0; i < n; i++) {
    subs.push({
      ...aim,
      angleDeg: aim.angleDeg + (i - mid) * step,
      projectile: def,
    });
  }
  return subs;
}
