import type { Carve, Damage, Mech, ProjectileDef, ShotInput } from "./types.js";
import type { TerrainMask } from "./terrain.js";

/**
 * THROW-STUB (Phase 1, plan 01). Real implementation lands in plan 04.
 *
 * Resolve a fired shot into terrain carves + per-mech damage. Returns ARRAYS so
 * multi-impact (multi-projectile patterns) is the native shape from day one
 * (TECHNICAL-DESIGN §5.2). Quantizes impact via `quantizeCarve` (the shared
 * boundary) so the server path and client path produce identical carves.
 */
export function resolveShot(
  _input: ShotInput,
  _terrain: TerrainMask,
  _mechs: Mech[],
  _def: ProjectileDef,
): { carves: Carve[]; damage: Damage[] } {
  throw new Error("resolveShot not implemented");
}

/** Per-mech blast damage: linear falloff + graze floor + direct-hit bonus. */
export function blastDamage(_dist: number, _def: ProjectileDef): number {
  throw new Error("blastDamage not implemented");
}
