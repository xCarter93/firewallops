/**
 * Pure angle-interpolation helpers for ENTITY INTERPOLATION of the opponent
 * barrel (smoothness fix).
 *
 * Synced Colyseus state arrives at ~20 Hz (the default 50 ms patch rate), so an
 * opponent's `angleDeg` lands in 50 ms steps. Rendering it directly snaps the
 * barrel; lerping the rendered angle toward the latest synced value every frame
 * removes that step. These helpers are kept PURE (no Phaser, no time source) so
 * they are unit-testable headless — the caller (MechView) owns the Phaser
 * rotation and feeds in the per-frame dt.
 *
 * Angles are ABSOLUTE sim degrees (0=right…90=up…180=left, the same value
 * `MechView.setBarrelAngle` consumes). Interpolation walks the SHORTEST arc so a
 * wrap near 0/360 never sweeps the long way around.
 */

/** Signed shortest angular distance from `from` to `to`, normalized to (-180, 180]. */
export function shortestAngleDeltaDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Lerp `from` toward `to` along the shortest arc by fraction `t` (clamped 0..1). */
export function lerpAngleDeg(from: number, to: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return from + shortestAngleDeltaDeg(from, to) * k;
}

/**
 * Frame-rate-independent smoothing fraction `1 - exp(-dtMs/tauMs)` — the share
 * of the remaining gap to close THIS frame. Using an exponential (vs a fixed
 * lerp constant) keeps the convergence identical at 30, 60, or 144 fps. At
 * tau≈70 ms the barrel closes ~63% of the gap every 70 ms, tracking a 50 ms
 * stream closely without stepping. A non-positive tau means "snap" (return 1);
 * negative/zero dt clamps to 0 (no movement).
 */
export function smoothingFactor(dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return 1;
  const dt = dtMs > 0 ? dtMs : 0;
  return 1 - Math.exp(-dt / tauMs);
}
