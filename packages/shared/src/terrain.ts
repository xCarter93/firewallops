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
