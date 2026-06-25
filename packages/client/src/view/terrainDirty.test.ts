import { describe, it, expect } from "vitest";
import { carveDirtyXRange } from "./terrainDirty.js";
import type { Carve } from "@shared/sim";

const carve = (cx: number, cy: number, r: number): Carve => ({ cx, cy, r });

describe("carveDirtyXRange", () => {
  it("returns null for no carves or non-positive width", () => {
    expect(carveDirtyXRange([], 1024)).toBeNull();
    expect(carveDirtyXRange([carve(100, 50, 24)], 0)).toBeNull();
  });

  it("spans a single carve's cx±r with 1px padding each side", () => {
    // cx 100, r 24 -> [76,124]; padded -> x0 = 75, x1 = 126.
    expect(carveDirtyXRange([carve(100, 50, 24)], 1024)).toEqual({ x0: 75, x1: 126 });
  });

  it("unions multiple carves into one band", () => {
    const range = carveDirtyXRange([carve(100, 50, 10), carve(300, 60, 20)], 1024);
    // min = 100-10 = 90 -> x0 89; max = 300+20 = 320 -> x1 322.
    expect(range).toEqual({ x0: 89, x1: 322 });
  });

  it("clamps the band to [0, width)", () => {
    // Left carve runs past 0, right carve past width.
    expect(carveDirtyXRange([carve(5, 10, 20)], 1024)).toEqual({ x0: 0, x1: 27 });
    expect(carveDirtyXRange([carve(1020, 10, 20)], 1024)).toEqual({ x0: 999, x1: 1024 });
  });

  it("returns null when the clamped band is empty", () => {
    // A carve entirely off the left edge collapses to an empty band.
    expect(carveDirtyXRange([carve(-100, 10, 5)], 1024)).toBeNull();
  });
});
