import { describe, it, expect } from "vitest";
import {
  TerrainMask,
  encodeMaskRLE,
  decodeMaskRLE,
} from "../src/index.js";
import type { MapDef } from "../src/types.js";

// SIM-04 / NET-05 RLE codec suite (Phase 3, plan 01). Proves the terrain
// collision mask round-trips byte-identically through the run-length codec —
// both a fresh mask and a post-carve (mid-match join snapshot) mask — and that
// the hardened decode path rejects corrupt/hostile buffers (Agreed Concern #7)
// BEFORE allocating or writing. Bare-Node Vitest (no jsdom): the codec is pure.

// Small deterministic fixture so the suite stays fast.
const MAP: MapDef = {
  width: 64,
  height: 48,
  seed: 3,
  baseHeight: 24,
  amplitude: 8,
  frequency: 0.1,
};

describe("encodeMaskRLE / decodeMaskRLE round-trip (NET-05)", () => {
  it("rle round-trips a fresh mask byte-identical", () => {
    const original = TerrainMask.fromMap(MAP);
    const decoded = decodeMaskRLE(encodeMaskRLE(original));

    expect(decoded.width).toBe(original.width);
    expect(decoded.height).toBe(original.height);
    expect(Array.from(decoded.bits)).toEqual(Array.from(original.bits));
  });

  it("rle round-trips a post-carve (mid-match) snapshot byte-identical", () => {
    // The NET-05 join-snapshot case: a joiner must see the same craters the
    // active players have already carved.
    const original = TerrainMask.fromMap(MAP);
    original.carveCircle(20, 30, 6);
    original.carveCircle(40, 28, 8);
    original.carveCircle(12, 44, 5);

    const decoded = decodeMaskRLE(encodeMaskRLE(original));

    expect(decoded.width).toBe(original.width);
    expect(decoded.height).toBe(original.height);
    expect(Array.from(decoded.bits)).toEqual(Array.from(original.bits));
  });

  it("rle handles an all-solid and an all-air mask", () => {
    // All-solid exercises the zero-length first run (bits[0] === 1).
    const allSolid = new TerrainMask(8, 8, new Uint8Array(64).fill(1));
    const solidDecoded = decodeMaskRLE(encodeMaskRLE(allSolid));
    expect(Array.from(solidDecoded.bits)).toEqual(Array.from(allSolid.bits));

    // All-air exercises a single run spanning the whole mask.
    const allAir = new TerrainMask(8, 8, new Uint8Array(64));
    const airDecoded = decodeMaskRLE(encodeMaskRLE(allAir));
    expect(Array.from(airDecoded.bits)).toEqual(Array.from(allAir.bits));
  });
});

describe("rle decode corrupt-input guards (Agreed Concern #7)", () => {
  it("decodeMaskRLE throws on a truncated buffer", () => {
    const encoded = encodeMaskRLE(TerrainMask.fromMap(MAP));
    // Keep the 8-byte header but drop the run bytes, so the runs cannot fill
    // width*height.
    const truncated = encoded.slice(0, 9);
    expect(() => decodeMaskRLE(truncated)).toThrow();
  });

  it("decodeMaskRLE rejects a sub-header buffer", () => {
    // Short-header guard fires BEFORE any read of the LE dimensions.
    expect(() => decodeMaskRLE(new Uint8Array(4))).toThrow(/8-byte header/);
  });

  it("decodeMaskRLE rejects over-bounds dimensions", () => {
    // Hand-craft a header claiming 9999x9999 (LE uint32s) + a trivial run byte.
    // The allocation cap must fire BEFORE allocating ~100M cells.
    const bad = new Uint8Array(9);
    const view = new DataView(bad.buffer);
    view.setUint32(0, 9999, true);
    view.setUint32(4, 9999, true);
    bad[8] = 0;
    expect(() => decodeMaskRLE(bad)).toThrow(/exceed map bounds/);
  });

  it("decodeMaskRLE rejects non-positive dimensions", () => {
    const bad = new Uint8Array(9);
    const view = new DataView(bad.buffer);
    view.setUint32(0, 0, true); // width = 0
    view.setUint32(4, 48, true);
    bad[8] = 0;
    expect(() => decodeMaskRLE(bad)).toThrow(/non-positive/);
  });
});
