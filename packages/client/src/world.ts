import type { MapDef } from "@shared/sim";

/**
 * Single source of truth for the world constants (Phase 2, plan 03).
 *
 * BootScene builds the collision mask + cosmetic DynamicTexture from MAP and
 * passes the live handles to MatchScene via scene init data. The mech start
 * X positions live here too; their Y is derived at runtime from the mask
 * surface (so the mechs sit on the procedural ground, not a hardcoded height).
 *
 * MAP mirrors the Phase 1 harness map (1024x512, seed 3, baseHeight 400,
 * amplitude 40, frequency 0.01) so client and server build byte-identical
 * masks — the SIM-04 parity basis.
 */
export const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

/** Player ids (P1 acts first; cyan-outlined active cue). */
export const P1_ID = "p1";
export const P2_ID = "p2";

/** Fixed horizontal start positions; Y is the mask surface at that X. */
export const P1_START_X = 150;
export const P2_START_X = 870;

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
