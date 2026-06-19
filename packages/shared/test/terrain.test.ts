import { describe, it, expect } from "vitest";
import { TerrainMask, quantizeCarve } from "../src/terrain.js";
import type { MapDef } from "../src/types.js";

// SIM-02 suite (Phase 1, plan 02). Proves: carve removes a circular chunk, the
// server-path and client-path masks are byte-identical for a fractional impact,
// fromMap is deterministic, a golden mask snapshot guards geometry drift, and
// the intentional floor(isSolid)-vs-round(carveCircle) ~1px skew is locked.

// One shared fixture. 256x128 with a baseHeight that lands the ground clearly in
// the lower region so picked pixels are reliably solid.
const MAP: MapDef = {
  width: 256,
  height: 128,
  seed: 7,
  baseHeight: 80,
  amplitude: 20,
  frequency: 0.02,
};

describe("TerrainMask.carveCircle (SIM-02)", () => {
  it("removes a circular chunk: center reads air, a pixel well outside the radius is unchanged", () => {
    const mask = TerrainMask.fromMap(MAP);

    // A pixel deep in the ground region (height-1 is always solid after clamp).
    const cx = 120;
    const cy = 120;
    const r = 14;

    const solidBefore = mask.isSolid(cx, cy);
    const farX = cx + r + 30;
    const farPixelBefore = mask.isSolid(farX, cy);

    mask.carveCircle(cx, cy, r);

    // The original center was solid (otherwise the carve proves nothing).
    expect(solidBefore).toBe(true);
    // Center is now air.
    expect(mask.isSolid(cx, cy)).toBe(false);
    // A pixel well outside the radius is unchanged.
    expect(mask.isSolid(farX, cy)).toBe(farPixelBefore);
  });
});

describe("byte-identical carve (SIM-04 keystone)", () => {
  it("a fractional impact carved via server-path and client-path yields deep-equal bits", () => {
    const r = 14;
    // Fractional on purpose: integer-quantization at the single boundary is what
    // makes this hold without any float-determinism heroics.
    const impact = { x: 120.5, y: 80.4999 };

    const server = TerrainMask.fromMap(MAP); // "server path"
    const client = TerrainMask.fromMap(MAP); // "client path", same def

    server.carveCircle(impact.x, impact.y, r);
    client.carveCircle(impact.x, impact.y, r);

    // THE byte-identical guarantee (Uint8Array deep equal).
    expect(client.bits).toEqual(server.bits);
  });
});

describe("fromMap determinism (SIM-04 supporting)", () => {
  it("builds byte-identical bits from the same def", () => {
    const a = TerrainMask.fromMap(MAP);
    const b = TerrainMask.fromMap(MAP);
    expect(a.bits).toEqual(b.bits);
  });
});

describe("golden carve mask snapshot (regression lock)", () => {
  it("a fixed carve at fixed integer coords matches the committed snapshot", () => {
    const mask = TerrainMask.fromMap(MAP);
    // Fixed integer carve — the integer Uint8Array snapshots cleanly
    // (RESEARCH Pitfall 3: snapshot the mask, NOT damage).
    mask.carveCircle(128, 100, 18);
    expect(mask.bits).toMatchSnapshot();
  });
});

describe("floor-vs-round sampling relationship (documented ~1px skew)", () => {
  it("isSolid floors the query while carveCircle (quantizeCarve) rounds the center", () => {
    // A float whose fractional part rounds UP across an integer boundary.
    const fx = 120.7;
    const fy = 80.3;
    const r = 14;

    // isSolid samples the pixel the projectile is currently over (FLOOR).
    expect(Math.floor(fx)).toBe(120);
    // carveCircle centers the crater on the nearest integer pixel (ROUND).
    const carve = quantizeCarve(fx, fy, r);
    expect(carve.cx).toBe(121);

    // The two intentionally differ by ~1px. This locks the documented behavior:
    // a future change to either rule trips this assertion.
    expect(carve.cx).not.toBe(Math.floor(fx));
  });
});
