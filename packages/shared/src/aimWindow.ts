/**
 * Per-mech AIM ANGLE WINDOW (AIM-01) — pure @shared/sim data + Math.
 *
 * A mech may only aim within a RELATIVE-to-facing angle band. v0 ships ONE
 * shared standard window (30°–70°); the API is structured so a future per-mech
 * MechDef (v2 MECH-01) can supply its OWN {minDeg,maxDeg} window WITHOUT a
 * sim-core change — every helper takes a `window` param defaulting to the shared
 * constant, so per-mech specialization is a pure DATA change at the call site.
 *
 * Angle convention (mirror of types.ts / aim.ts): the sim's ABSOLUTE angle is
 * 0 = right, 90 = up, 180 = left (y screen-down). The WINDOW is RELATIVE to
 * facing (0 = horizontal toward the enemy, 90 = straight up); `flipAngleByFacing`
 * maps relative↔absolute exactly as aim.ts's `facing === 1 ? angle : 180 - angle`.
 *
 * This module imports NOTHING from the game engine, the network layer, or the
 * DOM — pure data + Math. It re-passes the SIM-04 purity gate.
 */

/** A per-mech aim window: the relative-to-facing angle band a mech may aim within. */
export interface AimWindow {
  /** Lowest aimable RELATIVE angle, degrees (0 = horizontal toward the enemy). */
  minDeg: number;
  /** Highest aimable RELATIVE angle, degrees (90 = straight up). */
  maxDeg: number;
}

/**
 * The v0 STANDARD window — shared by every mech until per-mech windows land
 * (v2 MECH-01). A future MechDef carries its own AimWindow; this constant is the
 * single source consumers default to, so per-mech specialization is a data change.
 * FROZEN (review LOW) so no consumer can mutate the shared default at runtime.
 */
export const AIM_WINDOW: Readonly<AimWindow> = Object.freeze({ minDeg: 30, maxDeg: 70 });

/** Default relative aim = the window midpoint (a turn opens centered). */
export function aimWindowMid(window: AimWindow = AIM_WINDOW): number {
  return (window.minDeg + window.maxDeg) / 2;
}

/** Clamp a RELATIVE aim angle into [minDeg, maxDeg] (the client control side). */
export function clampRelativeAngle(relativeDeg: number, window: AimWindow = AIM_WINDOW): number {
  return Math.max(window.minDeg, Math.min(window.maxDeg, relativeDeg));
}

/**
 * relative ↔ absolute via facing. facing 1 (right) leaves the angle unchanged;
 * facing -1 (left) mirrors across vertical (180 - deg). Self-inverse, so ONE fn
 * converts both directions. Matches aim.ts's `180 - angle` rule exactly.
 */
export function flipAngleByFacing(deg: number, facing: 1 | -1): number {
  return facing === 1 ? deg : 180 - deg;
}

/**
 * AUTHORITATIVE clamp: take the ABSOLUTE angle a client sent, convert to relative
 * via the firing mech's facing, clamp into the window, return the clamped ABSOLUTE
 * angle. The server uses this so an out-of-window aim is corrected, never honored.
 */
export function clampAbsoluteAngle(absoluteDeg: number, facing: 1 | -1, window: AimWindow = AIM_WINDOW): number {
  const relative = flipAngleByFacing(absoluteDeg, facing);
  const clamped = clampRelativeAngle(relative, window);
  return flipAngleByFacing(clamped, facing);
}
