import type { Mech, ProjectileDef, ShotInput } from "@shared/sim";

/**
 * Pure aim → ShotInput mapper (Phase 2, plan 02) — PLAY-01.
 *
 * Extracted from the Scene so the angle/power/wind/shot → ShotInput mapping is
 * headless-testable in bare Node. The Scene supplies the live input values
 * (gauge angle/power, current wind, selected def); this function just shapes
 * them into the sim's ShotInput, taking the launch position from the firing
 * mech. No phaser, no side effects.
 */
export function buildShotInput(args: {
  mech: Mech;
  angleDeg: number;
  power: number;
  wind: number;
  gravity: number;
  def: ProjectileDef;
}): ShotInput {
  return {
    x: args.mech.x,
    y: args.mech.y,
    angleDeg: args.angleDeg,
    power: args.power,
    wind: args.wind,
    gravity: args.gravity,
    projectile: args.def,
  };
}
