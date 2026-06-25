import type { Carve } from "@shared/sim";

/** A half-open column band [x0, x1) of the terrain texture to repaint. */
export interface DirtyXRange {
  x0: number;
  x1: number;
}

/**
 * Compute the column band a set of carves can affect, clamped to [0, width).
 *
 * Carving a circle at (cx, cy, r) can only change the top-most solid cell of
 * columns within `cx ± r`, so the cosmetic terrain texture only needs
 * repainting across that x-range — not the whole O(width·height) field — which
 * removes the per-impact frame hitch. One extra column of padding each side
 * covers float→int rounding. Returns `null` when there is nothing to repaint
 * (no carves, zero width, or an empty band), in which case the caller should
 * skip the repaint or fall back to a full one.
 *
 * Pure (no Phaser) so it is unit-testable headless.
 */
export function carveDirtyXRange(
  carves: readonly Carve[],
  width: number,
): DirtyXRange | null {
  if (carves.length === 0 || width <= 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const c of carves) {
    if (c.cx - c.r < min) min = c.cx - c.r;
    if (c.cx + c.r > max) max = c.cx + c.r;
  }
  const x0 = Math.max(0, Math.floor(min) - 1);
  const x1 = Math.min(width, Math.ceil(max) + 2);
  if (x1 <= x0) return null;
  return { x0, x1 };
}
