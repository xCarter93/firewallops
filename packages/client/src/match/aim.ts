import type { Mech, ProjectileDef, ShotInput } from "@shared/sim";

/**
 * Pure aim → ShotInput mapper (Phase 2, plan 02) — PLAY-01.
 *
 * Extracted from the Scene so the angle/power/wind/shot → ShotInput mapping is
 * headless-testable in bare Node. The Scene supplies the live input values
 * (gauge angle/power, current wind, selected def); this function just shapes
 * them into the sim's ShotInput, taking the launch position from the firing
 * mech. No phaser, no side effects.
 *
 * FACING (02-04 NO-GO fix 2): the on-screen aim stays in the 0–90 band
 * (relative-to-facing), but the sim's angle convention is ABSOLUTE
 * (0=right…90=up…180=left, y-down). `facing` converts the relative angle into
 * the absolute sim angle so a player on the right (facing -1) can aim LEFT at an
 * opponent. `facing: 1` (right, default) leaves the angle unchanged so the
 * existing PLAY-01 test still passes; `facing: -1` (left) mirrors it across the
 * vertical: `absoluteDeg = 180 - relativeAngle` (e.g. 30 → 150, 90 → 90).
 */
export function buildShotInput(args: {
  mech: Mech;
  angleDeg: number;
  power: number;
  wind: number;
  gravity: number;
  def: ProjectileDef;
  facing?: 1 | -1;
}): ShotInput {
  const facing = args.facing ?? 1;
  const absoluteDeg = facing === 1 ? args.angleDeg : 180 - args.angleDeg;
  return {
    x: args.mech.x,
    y: args.mech.y,
    angleDeg: absoluteDeg,
    power: args.power,
    wind: args.wind,
    gravity: args.gravity,
    projectile: args.def,
  };
}
