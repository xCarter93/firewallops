import type { Carve, MapDef } from "./types.js";

/**
 * The single float→int quantization seam (review concern #1).
 *
 * This standalone exported function is the ONE place float→int carve
 * quantization happens. BOTH `TerrainMask.carveCircle` and `resolveShot`
 * (plan 04) route through it, so the recorded `Carve` and the carved mask can
 * never diverge — this is the structural basis for the SIM-04 byte-identical
 * guarantee.
 *
 * LOCKED RULE: `Math.round` for center AND radius (RESEARCH A2: either floor or
 * round works for parity; round is chosen and must be used everywhere). Do not
 * introduce a second quantization rule anywhere in the codebase.
 */
export function quantizeCarve(
  cxFloat: number,
  cyFloat: number,
  rFloat: number,
): Carve {
  return {
    cx: Math.round(cxFloat),
    cy: Math.round(cyFloat),
    r: Math.round(rFloat),
  };
}

/**
 * 1-bit destructible-terrain collision mask (1 = solid, 0 = air). The mask is
 * the collision authority both the client (Phase 2 preview) and the server
 * (Phase 3 authority) import; the visual terrain layer (Phase 2 Phaser) is a
 * separate concern and is never consulted for physics.
 *
 * Storage is a flat `Uint8Array` of length `width * height` indexed as
 * `y * width + x` (NOT bit-packed — Claude's-discretion-locked per
 * CONTEXT/RESEARCH because it is simpler to carve and snapshot; revisit packing
 * only when a real map size demands it).
 *
 * Coordinate system: origin top-left, y is screen-DOWN — "ground" is the lower
 * (larger-y) portion of the mask.
 *
 * SAMPLING RULE (review concern #9): `isSolid` FLOORS its query coordinate while
 * `carveCircle` ROUNDS its center (via `quantizeCarve`). This is intentional —
 * collision detection samples the pixel the projectile is currently over
 * (floor), while the crater is centered on the nearest integer pixel (round).
 * The two rules can differ by up to ~1px: a float impact at `(120.7, 80.3)` is
 * detected over pixel `(120, 80)` but carved centered at `(121, 80)`. For the
 * spike this sub-pixel skew is acceptable and is explicitly tested in
 * terrain.test.ts; if Phase 2 needs pixel-exact impact/carve alignment, align
 * both to the same rule then.
 */
export class TerrainMask {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly bits: Uint8Array,
  ) {}

  /**
   * Build a mask from a procedural heightmap definition.
   *
   * Deterministic: the same `def` produces byte-identical bits every call (no
   * `Math.random`, no Date) — a precondition for the SIM-04 server/client carve
   * parity. The `fromMap` signature is the SEAM: a PNG-alpha or authored-map
   * loader can slot in later (Phase 2/6) without changing callers. Do NOT build
   * a PNG decoder now.
   */
  static fromMap(def: MapDef): TerrainMask {
    const { width, height } = def;
    const bits = new Uint8Array(width * height);

    // Inlined deterministic PRNG (mulberry32, ~5 lines) seeded from def.seed to
    // derive a stable phase offset. Inlined on purpose: adding an npm RNG would
    // violate the zero-runtime-deps rule (RESEARCH "Don't Hand-Roll" exception).
    let a = def.seed >>> 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const rand = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const seedPhase = rand * Math.PI * 2;

    for (let x = 0; x < width; x++) {
      // Deterministic summed-sine surface plus the seeded phase jitter.
      const surface =
        def.baseHeight +
        def.amplitude *
          (Math.sin(x * def.frequency) * 0.6 +
            Math.sin(x * def.frequency * 2.3 + seedPhase) * 0.4);

      // Round to an integer AND clamp into [0, height-1] so an out-of-range
      // heightmap param can never write outside the array or leave a column
      // with no ground (review polish).
      let groundY = Math.round(surface);
      if (groundY < 0) groundY = 0;
      if (groundY > height - 1) groundY = height - 1;

      // Ground is the lower portion (screen-y-down): solid for all y >= groundY.
      for (let y = groundY; y < height; y++) {
        bits[y * width + x] = 1;
      }
    }

    return new TerrainMask(width, height, bits);
  }

  /**
   * True if the pixel at (x, y) is solid ground.
   *
   * FLOORS x,y for the array read (see the class-level SAMPLING RULE note). Out
   * of bounds reads as NOT solid so the trajectory's `outOfBounds` branch owns
   * the off-map case rather than this collision query.
   */
  isSolid(x: number, y: number): boolean {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) {
      return false;
    }
    return this.bits[iy * this.width + ix] === 1;
  }

  /** True if (x, y) is outside the mask bounds. */
  outOfBounds(x: number, y: number): boolean {
    return x < 0 || y < 0 || x >= this.width || y >= this.height;
  }

  /**
   * Carve a filled circle of air — THE SIM-04 KEYSTONE.
   *
   * Floats are quantized at exactly one boundary: `carveCircle` does NOT round
   * inline, it consumes `quantizeCarve` (the same function `resolveShot` records
   * from), so the carved mask and the recorded `Carve` can never diverge.
   */
  carveCircle(cxFloat: number, cyFloat: number, r: number): void {
    // Defensive guard FIRST: a non-finite coord/radius or a negative radius
    // would otherwise create a runaway/empty loop. `!Number.isFinite` catches
    // both NaN and Infinity (RESEARCH Security V5 — obvious nonsense guarded;
    // real input validation is Phase 3's job).
    if (
      !Number.isFinite(cxFloat) ||
      !Number.isFinite(cyFloat) ||
      !Number.isFinite(r) ||
      r < 0
    ) {
      return;
    }

    // Quantize via the shared helper — do NOT round inline.
    const { cx, cy, r: ri } = quantizeCarve(cxFloat, cyFloat, r);
    const r2 = ri * ri;

    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy <= r2) {
          this.setAir(cx + dx, cy + dy);
        }
      }
    }
  }

  /** Bounds-checked write of air (0) at an integer pixel. */
  private setAir(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.bits[y * this.width + x] = 0;
  }
}

/**
 * Allocation sanity cap for `decodeMaskRLE` — the largest legitimate mask this
 * phase ever decodes. Mirrors the world `MAP` constants in
 * packages/client/src/world.ts (2048 x 1408). A hostile snapshot claiming a
 * larger size is rejected BEFORE `new Uint8Array(width*height)` so a corrupt
 * header cannot force a huge allocation. Phase 5 reconnection snapshots flow
 * through this SAME guard — if a real map ever exceeds 2048x1408, bump these
 * two constants (and the cross-version note below) deliberately.
 */
const MAX_W = 2048;
const MAX_H = 1408;

/**
 * Run-length encode the flat collision mask into a self-describing byte buffer.
 *
 * NET-05 join snapshot: a mid-match joiner (or a Phase 5 reconnect) needs the
 * FULL current mask in one payload (carve-replay only covers steady-state). This
 * is the only serialize path off a `TerrainMask`.
 *
 * Wire format (little-endian, no external schema needed beyond these bytes):
 *   - bytes 0..3  : width  as LE uint32
 *   - bytes 4..7  : height as LE uint32
 *   - bytes 8..   : a sequence of LEB128 unsigned varint run lengths.
 *
 * The mask values are only ever 0 or 1, so runs alternate value 0,1,0,1,…. The
 * FIRST run is ALWAYS the count of leading 0 (air) bits — emit a zero-length
 * first run when `bits[0] === 1`. The run lengths MUST sum to `width*height`.
 * LEB128 (7 data bits/byte, high bit = continuation) is used so a run wider than
 * 255 (a full air row is `width` wide) is never truncated.
 *
 * v0 wire format has no magic/version byte; add one before any cross-version
 * snapshot in Phase 5 — the self-describing LE-dimension header already prevents
 * a stale-MAP decode, so a magic byte adds wire churn for no Phase 3 benefit.
 *
 * Pure: no DOM, engine, network, or Node-only types — only Uint8Array,
 * DataView, and Math (all ES2022 built-ins under the shared tsconfig).
 */
export function encodeMaskRLE(mask: TerrainMask): Uint8Array {
  if (mask.bits.length !== mask.width * mask.height) {
    throw new Error("encodeMaskRLE: bits length does not match width*height");
  }

  // Collect alternating run lengths starting from value 0 (air). A leading
  // solid pixel produces a zero-length first run so decode's "start at 0" rule
  // holds with no special case.
  const runs: number[] = [];
  let current = 0; // the value the next run counts
  let run = 0;
  for (let i = 0; i < mask.bits.length; i++) {
    const v = mask.bits[i];
    if (v === current) {
      run++;
    } else {
      runs.push(run);
      current = current === 0 ? 1 : 0;
      run = 1;
    }
  }
  // Push the final run. For an empty mask (length 0) the single run is 0.
  runs.push(run);

  // Size the output exactly: 8-byte header + varint bytes for every run.
  let varintBytes = 0;
  for (const r of runs) {
    varintBytes += varintByteLength(r);
  }

  const out = new Uint8Array(8 + varintBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, mask.width, true);
  view.setUint32(4, mask.height, true);

  let offset = 8;
  for (const r of runs) {
    offset = writeVarint(out, offset, r);
  }
  return out;
}

/** Number of LEB128 bytes a non-negative integer encodes to. */
function varintByteLength(value: number): number {
  let n = 1;
  let v = value;
  while (v >= 0x80) {
    v = Math.floor(v / 0x80);
    n++;
  }
  return n;
}

/** Write a non-negative integer as LEB128 at `offset`; returns the new offset. */
function writeVarint(out: Uint8Array, offset: number, value: number): number {
  let v = value;
  let o = offset;
  while (v >= 0x80) {
    out[o++] = (v & 0x7f) | 0x80;
    v = Math.floor(v / 0x80);
  }
  out[o++] = v & 0x7f;
  return o;
}

/**
 * Decode a self-describing RLE buffer (see {@link encodeMaskRLE}) back into a
 * byte-identical `TerrainMask`.
 *
 * SIGNATURE NOTE: takes a SINGLE `bytes` argument — width/height come from the
 * header, NOT from the caller. This diverges from the RESEARCH.md sketch
 * `decodeMaskRLE(bytes, width, height)`: the header-carries-dimensions form
 * makes the payload fully self-describing, so a client can never decode against
 * a stale MAP size.
 *
 * HARDENED against corrupt/hostile snapshots (Agreed Concern #7 — Codex/Cursor
 * "decode DoS/corrupt-buffer"). Every guard runs BEFORE the matching allocation
 * or write, so a malformed buffer fails loudly rather than allocating huge
 * memory or producing a silently-wrong collision mask:
 *   - short header   → throw before reading the LE uint32s
 *   - non-positive   → throw before allocating
 *   - over-bounds    → throw before allocating (MAX_W x MAX_H cap)
 *   - unterminated   → throw if a varint's continuation bit runs off the buffer
 *   - run overflow   → throw if a varint accumulates past width*height
 *   - run past mask  → throw before the fill loop (no out-of-bounds writes)
 *   - underfill      → throw if the runs do not sum to width*height
 *
 * Pure: no DOM, engine, network, or Node-only types — throws plain Errors and
 * references only local integer constants. SIM-04 purity gate stays green.
 */
export function decodeMaskRLE(bytes: Uint8Array): TerrainMask {
  // --- Header guards (BEFORE any read of dimensions / any allocation) ---
  if (bytes.length < 8) {
    throw new Error("decodeMaskRLE: buffer shorter than 8-byte header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);

  if (width <= 0 || height <= 0) {
    throw new Error("decodeMaskRLE: non-positive dimensions");
  }
  if (width > MAX_W || height > MAX_H) {
    throw new Error("decodeMaskRLE: dimensions exceed map bounds");
  }

  const total = width * height;
  // Allocate ONLY after the guards pass.
  const bits = new Uint8Array(total);

  let readCursor = 8;
  let writeCursor = 0;
  let value = 0; // first run is air (0), then alternate

  while (readCursor < bytes.length) {
    // --- Decode one LEB128 varint with overflow + unterminated guards ---
    let run = 0;
    let shift = 1; // multiplier for the current 7-bit group (1, 128, 16384, …)
    let byte: number;
    do {
      if (readCursor >= bytes.length) {
        throw new Error("decodeMaskRLE: unterminated varint");
      }
      byte = bytes[readCursor++];
      run += (byte & 0x7f) * shift;
      if (run > total) {
        throw new Error("decodeMaskRLE: run length overflow");
      }
      shift *= 0x80;
    } while ((byte & 0x80) !== 0);

    // --- Bounds-check BEFORE filling (no out-of-bounds writes) ---
    if (writeCursor + run > total) {
      throw new Error("decodeMaskRLE: run overflows width*height");
    }

    if (value === 1) {
      bits.fill(1, writeCursor, writeCursor + run);
    }
    // value 0 runs are already 0 from the zero-filled allocation.
    writeCursor += run;
    value = value === 0 ? 1 : 0;
  }

  // The runs MUST exactly fill the mask — a truncated/corrupt buffer that under-
  // fills fails loudly rather than yielding a silently-wrong mask.
  if (writeCursor !== total) {
    throw new Error("decodeMaskRLE: run lengths do not fill width*height");
  }

  return new TerrainMask(width, height, bits);
}
