import { describe, it, expect } from "vitest";
import { TerrainMask } from "@shared/sim";
import { MAP, P1_START_X, P2_START_X, surfaceY } from "./world.js";

/**
 * Resize-parity guard for the REAL client MAP.
 *
 * The shared `terrain.test.ts` pins its OWN 256x128 fixture and never imports
 * `world.ts`, so it cannot prove the 2048x768 resize. This suite builds the
 * mask from the actual shipped `MAP` and proves: the grown dims materialize,
 * the re-spaced starts are wired, both mechs seat on valid in-bounds ground,
 * and `fromMap` stays byte-identical at the size that actually ships.
 */
describe("client MAP resize (2048x768)", () => {
  const mask = TerrainMask.fromMap(MAP);

  it("materializes the grown-world dims from the client MAP", () => {
    expect(mask.width).toBe(2048);
    expect(mask.height).toBe(768);
  });

  it("wires the re-spaced mech start columns", () => {
    expect(P1_START_X).toBe(300);
    expect(P2_START_X).toBe(1748);
  });

  it("seats both mechs on valid in-bounds ground", () => {
    for (const x of [300, 1748]) {
      const y = surfaceY((sx, sy) => mask.isSolid(sx, sy), x, mask.height);
      // surfaceY returns `height` (the air sentinel) when the column is all
      // air; a valid surface is strictly inside (0, height) and itself solid.
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(mask.height);
      expect(mask.isSolid(x, y)).toBe(true);
    }
  });

  it("is byte-identical (deterministic) at the shipped dims", () => {
    const b = TerrainMask.fromMap(MAP);
    expect(b.bits).toEqual(mask.bits);
  });
});
