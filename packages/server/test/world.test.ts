import { describe, it, expect } from "vitest";
import { TerrainMask } from "@shared/sim";
import { MAP, randomDummyX } from "@firewallops/match-core";

/**
 * Pure world-helper coverage (Phase 8, TR-5). `randomDummyX` is pure geometry
 * (band-uniform x in the team-1 right band [1148, 1848]); tested headlessly with
 * a deterministic injected rng to pin the band bounds, and across many random
 * calls to lock the band membership.
 */
describe("randomDummyX", () => {
  const mask = TerrainMask.fromMap(MAP);

  it("maps the rng output across the team-1 band [1148, 1848]", () => {
    // rng=0 → lo bound; rng=1 → hi bound; rng=0.5 → midpoint.
    expect(randomDummyX(mask, () => 0)).toBe(1148);
    expect(randomDummyX(mask, () => 1)).toBe(1848);
    expect(randomDummyX(mask, () => 0.5)).toBe(Math.round((1148 + 1848) / 2));
    // Sanity: the midpoint is 1498.
    expect(randomDummyX(mask, () => 0.5)).toBe(1498);
  });

  it("every random call lands an integer inside the team-1 band [1148, 1848]", () => {
    for (let i = 0; i < 50; i++) {
      const x = randomDummyX(mask);
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(1148);
      expect(x).toBeLessThanOrEqual(1848);
    }
  });
});
