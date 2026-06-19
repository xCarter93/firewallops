import type { MapDef } from "@shared/sim";

/**
 * Single source of truth for the world constants (Phase 2, plan 03).
 *
 * BootScene builds the collision mask + cosmetic DynamicTexture from MAP and
 * passes the live handles to MatchScene via scene init data. The mech start
 * X positions live here too; their Y is derived at runtime from the mask
 * surface (so the mechs sit on the procedural ground, not a hardcoded height).
 *
 * MAP mirrors the Phase 1 harness map (2048-wide, seed 3, baseHeight 400,
 * amplitude 40, frequency 0.01) so client and server build byte-identical
 * masks — the SIM-04 parity basis. The heightmap is a function of x only
 * (frequency/amplitude/baseHeight/seed), so `height` does NOT change the surface
 * profile — it only changes how far the solid ground extends BELOW it.
 *
 * Geometry nuance: `height` is the world's vertical extent. The playable surface
 * stays at ~y=400 regardless; growing `height` 768→1408 just fills more solid
 * ground underneath. This matters because the canvas now fills the whole browser
 * window (game-config Scale.RESIZE): a tall viewport (~1300px+) framed on a mech
 * would otherwise run off the bottom of a 768-tall world and reveal the dark
 * background as a seam below the terrain. 1408 keeps ground under the deepest
 * framed view; the sky ABOVE the surface (for steep arcs) comes from the
 * camera's negative top bound in MatchScene, not from MAP (sky = backgroundColor).
 *
 * Repaint cost: `TerrainView.paint` is O(width*height), so 2048x1408 is ~1.8x the
 * per-repaint work of 2048x768 — acceptable because it runs once per resolved
 * shot (never per-frame); revisit with a dirty-rect repaint only if a profiling
 * hitch appears on impact.
 */
export const MAP: MapDef = {
  width: 2048,
  height: 1408,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

/** Player ids (P1 acts first; cyan-outlined active cue). */
export const P1_ID = "p1";
export const P2_ID = "p2";

/** Fixed horizontal start positions; Y is the mask surface at that X. */
export const P1_START_X = 300;
export const P2_START_X = 1748;

/** Mech body dimensions (placeholder geometric art, UI-SPEC). */
export const MECH_BODY_W = 28;
export const MECH_BODY_H = 18;

/**
 * Find the topmost solid Y at column `x` (scan from the top down for the first
 * solid pixel). Used to seat mechs on the ground and for walk-collision.
 * Returns `height` if the column is entirely air.
 */
export function surfaceY(
  isSolid: (x: number, y: number) => boolean,
  x: number,
  height: number,
): number {
  for (let y = 0; y < height; y++) {
    if (isSolid(x, y)) return y;
  }
  return height;
}
