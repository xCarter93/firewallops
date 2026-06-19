import { describe, it, expect } from "vitest";
import { TerrainMask } from "../src/terrain.js";
import type { MapDef } from "../src/types.js";

// RED scaffold (Phase 1, plan 01): TerrainMask is a throw-stub. Implementation
// lands in plan 02. Tests typecheck but throw at runtime.

const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 7,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

describe("TerrainMask.carveCircle (SIM-02)", () => {
  it("removes a circular chunk: center reads air, a pixel well outside the radius is unchanged", () => {
    const terrain = TerrainMask.fromMap(MAP);

    // Pick a point known to be solid ground (well below the surface baseline).
    const cx = 200;
    const cy = 450;
    const r = 14;

    const solidBefore = terrain.isSolid(cx, cy);
    const farPixelBefore = terrain.isSolid(cx + r + 30, cy);

    terrain.carveCircle(cx, cy, r);

    // Center is now air.
    expect(terrain.isSolid(cx, cy)).toBe(false);
    // The original center was solid (otherwise the carve proves nothing).
    expect(solidBefore).toBe(true);
    // A pixel well outside the radius is unchanged.
    expect(terrain.isSolid(cx + r + 30, cy)).toBe(farPixelBefore);
  });
});

describe("byte-identical carve (SIM-04 keystone)", () => {
  it("a fractional impact carved via server-path and client-path yields deep-equal bits", () => {
    const r = 14;
    // Fractional on purpose: round-vs-floor drift is exactly what this guards.
    const impactX = 120.5;
    const impactY = 80.4999;

    const server = TerrainMask.fromMap(MAP); // "server path"
    const client = TerrainMask.fromMap(MAP); // "client path", same def

    server.carveCircle(impactX, impactY, r);
    client.carveCircle(impactX, impactY, r);

    expect(client.bits).toEqual(server.bits);
  });
});
