import type { ProjectileBehavior } from "./types.js";

/**
 * THROW-STUB (Phase 1, plan 01). Real implementation lands in plan 02/04.
 *
 * The default ballistic projectile behavior. All three behavioral dimensions
 * (flight step, sub-shot spawn, damage combine) are stubbed; the real default
 * returns plain wind+gravity, a single-shot passthrough, and a simple combine.
 */
export const DEFAULT_BEHAVIOR: ProjectileBehavior = {
  step() {
    throw new Error("DEFAULT_BEHAVIOR.step not implemented");
  },
  createSubShots() {
    throw new Error("DEFAULT_BEHAVIOR.createSubShots not implemented");
  },
  combineDamage() {
    throw new Error("DEFAULT_BEHAVIOR.combineDamage not implemented");
  },
};

/** Resolve a behavior key to its registered strategy object. */
export function getBehavior(_key: string): ProjectileBehavior {
  throw new Error("getBehavior not implemented");
}
