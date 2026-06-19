import type { Carve, MapDef } from "./types.js";

/**
 * THROW-STUB (Phase 1, plan 01). Real implementation lands in plan 02.
 *
 * 1-bit destructible-terrain collision mask (1 = solid, 0 = air). The mask is
 * the collision authority; the visual terrain layer (Phase 2 Phaser) is
 * separate and never consulted for physics.
 */
export class TerrainMask {
  constructor(
    readonly w: number,
    readonly h: number,
    readonly bits: Uint8Array,
  ) {}

  /** Build a mask from a procedural heightmap definition. */
  static fromMap(_def: MapDef): TerrainMask {
    throw new Error("TerrainMask.fromMap not implemented");
  }

  /** True if the pixel at (x, y) is solid ground. */
  isSolid(_x: number, _y: number): boolean {
    throw new Error("TerrainMask.isSolid not implemented");
  }

  /** True if (x, y) is outside the mask bounds. */
  outOfBounds(_x: number, _y: number): boolean {
    throw new Error("TerrainMask.outOfBounds not implemented");
  }

  /** Carve a filled circle of air. Floats are quantized at this boundary. */
  carveCircle(_cx: number, _cy: number, _r: number): void {
    throw new Error("TerrainMask.carveCircle not implemented");
  }
}

/**
 * The single float→int quantization seam. BOTH `carveCircle` and `resolveShot`
 * route through this so the server path and client path carve byte-identically.
 * Real implementation (locked rounding rule) lands in plan 02.
 */
export function quantizeCarve(
  _cxFloat: number,
  _cyFloat: number,
  _rFloat: number,
): Carve {
  throw new Error("quantizeCarve not implemented");
}
