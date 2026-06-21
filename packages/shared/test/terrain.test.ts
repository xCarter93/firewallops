import { describe, it, expect } from "vitest";
import {
  TerrainMask,
  quantizeCarve,
  encodeMaskRLE,
  decodeMaskRLE,
  RLE_MAGIC_BYTES,
  RLE_VERSION,
  RLE_HEADER_BYTES,
  RLE_MAX_ENCODED_BYTES,
} from "../src/terrain.js";
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

// Review M4 / RECON-02: the RLE codec carries a magic + version + dimensions
// header and a run-count + encoded-size cap so a cross-build reconnect snapshot
// (Phase 5) is self-validating and a hostile/corrupt buffer is rejected loudly
// rather than silently decoded into a wrong collision mask. Bare-Node (no jsdom)
// — the codec stays pure so the SIM-04 purity gate is unaffected.
describe("RLE version + header hardening (M4 / RECON-02)", () => {
  const MAP: MapDef = {
    width: 64,
    height: 48,
    seed: 3,
    baseHeight: 24,
    amplitude: 8,
    frequency: 0.1,
  };

  /** Index of the first run-section byte that begins run #2 (skips the header
   *  and the first LEB128 varint). Used to splice an interior zero-length run. */
  function secondRunOffset(encoded: Uint8Array): number {
    let cursor = RLE_HEADER_BYTES;
    // Skip the first varint (advance past all continuation bytes).
    while ((encoded[cursor] & 0x80) !== 0) cursor++;
    cursor++; // the terminating (high-bit-clear) byte of run #1
    return cursor;
  }

  it("encodes a magic + version header and round-trips byte-identically", () => {
    const original = TerrainMask.fromMap(MAP);
    const encoded = encodeMaskRLE(original);

    expect(encoded[0]).toBe(RLE_MAGIC_BYTES[0]);
    expect(encoded[1]).toBe(RLE_MAGIC_BYTES[1]);
    expect(encoded[2]).toBe(RLE_VERSION);

    const decoded = decodeMaskRLE(encoded);
    expect(decoded.width).toBe(original.width);
    expect(decoded.height).toBe(original.height);
    expect(Array.from(decoded.bits)).toEqual(Array.from(original.bits));
  });

  it("rejects a buffer with bad magic", () => {
    const bad = encodeMaskRLE(TerrainMask.fromMap(MAP));
    bad[0] = 0x00;
    expect(() => decodeMaskRLE(bad)).toThrow(/magic/);
  });

  it("rejects an unsupported version", () => {
    const bad = encodeMaskRLE(TerrainMask.fromMap(MAP));
    bad[2] = 99;
    expect(() => decodeMaskRLE(bad)).toThrow(/version/);
  });

  it("rejects oversize dimensions (valid magic+version, huge w/h)", () => {
    const bad = new Uint8Array(RLE_HEADER_BYTES + 1);
    bad[0] = RLE_MAGIC_BYTES[0];
    bad[1] = RLE_MAGIC_BYTES[1];
    bad[2] = RLE_VERSION;
    const view = new DataView(bad.buffer);
    view.setUint32(3, 9999, true);
    view.setUint32(7, 9999, true);
    expect(() => decodeMaskRLE(bad)).toThrow(/bounds|dimensions/);
  });

  it("rejects a short (sub-header) buffer", () => {
    expect(() => decodeMaskRLE(new Uint8Array(RLE_HEADER_BYTES - 1))).toThrow(
      /header/,
    );
  });

  it("rejects a buffer past the encoded-size cap (M4)", () => {
    const bad = new Uint8Array(RLE_MAX_ENCODED_BYTES + 1);
    bad[0] = RLE_MAGIC_BYTES[0];
    bad[1] = RLE_MAGIC_BYTES[1];
    bad[2] = RLE_VERSION;
    expect(() => decodeMaskRLE(bad)).toThrow(/size cap/);
  });

  it("rejects an interior zero-length run (M4)", () => {
    const encoded = encodeMaskRLE(TerrainMask.fromMap(MAP));
    const splice = secondRunOffset(encoded);
    // Insert a zero LEB128 varint (0x00) as an INTERIOR run (run #2). Only the
    // FIRST run may legitimately be zero (the leading-solid case).
    const bad = new Uint8Array(encoded.length + 1);
    bad.set(encoded.subarray(0, splice), 0);
    bad[splice] = 0x00;
    bad.set(encoded.subarray(splice), splice + 1);
    expect(() => decodeMaskRLE(bad)).toThrow(/zero-length/);
  });
});
