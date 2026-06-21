import { describe, it, expect } from "vitest";
import {
  AIM_WINDOW,
  aimWindowMid,
  clampRelativeAngle,
  flipAngleByFacing,
  clampAbsoluteAngle,
} from "../src/index.js";

/**
 * AIM_WINDOW suite (Phase 5, plan 07 — AIM-01). Locks the FROZEN standard
 * window (30°–70°), the relative/absolute clamp, and the self-inverse facing
 * flip. Bare-Node Vitest (no jsdom): the aim window is pure data + Math, so it
 * re-passes the SIM-04 purity gate. Titled "AIM_WINDOW" so `-t "AIM_WINDOW"`
 * selects it.
 */
describe("AIM_WINDOW constant (AIM-01)", () => {
  it("is exactly the v0 standard window 30–70", () => {
    expect(AIM_WINDOW).toEqual({ minDeg: 30, maxDeg: 70 });
  });

  it("is FROZEN (no consumer can mutate the shared default)", () => {
    expect(Object.isFrozen(AIM_WINDOW)).toBe(true);
  });

  it("aimWindowMid() is the midpoint 50 (a turn opens centered)", () => {
    expect(aimWindowMid()).toBe(50);
  });

  it("aimWindowMid honors a per-mech window param (v2 MECH-01 ready)", () => {
    expect(aimWindowMid({ minDeg: 20, maxDeg: 80 })).toBe(50);
    expect(aimWindowMid({ minDeg: 10, maxDeg: 40 })).toBe(25);
  });
});

describe("clampRelativeAngle (AIM-01)", () => {
  it("pulls below-min up to minDeg", () => {
    expect(clampRelativeAngle(10)).toBe(30);
  });

  it("pulls above-max down to maxDeg", () => {
    expect(clampRelativeAngle(80)).toBe(70);
  });

  it("leaves an in-window angle untouched", () => {
    expect(clampRelativeAngle(50)).toBe(50);
  });

  it("respects a custom per-mech window param", () => {
    expect(clampRelativeAngle(10, { minDeg: 0, maxDeg: 90 })).toBe(10);
    expect(clampRelativeAngle(95, { minDeg: 0, maxDeg: 90 })).toBe(90);
  });
});

describe("flipAngleByFacing (AIM-01)", () => {
  it("leaves facing 1 (right) unchanged", () => {
    expect(flipAngleByFacing(30, 1)).toBe(30);
    expect(flipAngleByFacing(70, 1)).toBe(70);
  });

  it("mirrors facing -1 (left) across vertical (180 - deg)", () => {
    expect(flipAngleByFacing(30, -1)).toBe(150);
    expect(flipAngleByFacing(70, -1)).toBe(110);
  });

  it("is self-inverse for both facings", () => {
    for (const deg of [0, 30, 50, 70, 90]) {
      expect(flipAngleByFacing(flipAngleByFacing(deg, 1), 1)).toBe(deg);
      expect(flipAngleByFacing(flipAngleByFacing(deg, -1), -1)).toBe(deg);
    }
  });
});

describe("clampAbsoluteAngle (AIM-01)", () => {
  it("facing 1: corrects an out-of-window absolute angle to the bound", () => {
    expect(clampAbsoluteAngle(10, 1)).toBe(30);
    expect(clampAbsoluteAngle(80, 1)).toBe(70);
    expect(clampAbsoluteAngle(50, 1)).toBe(50);
  });

  it("facing -1: corrects in ABSOLUTE terms (rel via 180 - abs)", () => {
    // abs 170 -> rel 10 -> clamp 30 -> abs 150
    expect(clampAbsoluteAngle(170, -1)).toBe(150);
    // abs 100 -> rel 80 -> clamp 70 -> abs 110
    expect(clampAbsoluteAngle(100, -1)).toBe(110);
    // abs 130 -> rel 50 -> in-window -> abs 130
    expect(clampAbsoluteAngle(130, -1)).toBe(130);
  });

  it("honors a per-mech window param (v2 MECH-01 ready)", () => {
    // wider window {0,90}: abs 10 facing 1 stays 10 (in-window)
    expect(clampAbsoluteAngle(10, 1, { minDeg: 0, maxDeg: 90 })).toBe(10);
  });
});
