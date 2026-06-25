import { describe, it, expect } from "vitest";
import { shortestAngleDeltaDeg, lerpAngleDeg, smoothingFactor } from "./angleInterp.js";

describe("shortestAngleDeltaDeg", () => {
  it("returns a plain difference within range", () => {
    expect(shortestAngleDeltaDeg(30, 60)).toBe(30);
    expect(shortestAngleDeltaDeg(60, 30)).toBe(-30);
    expect(shortestAngleDeltaDeg(45, 45)).toBe(0);
  });

  it("walks the SHORT way around the 0/360 wrap", () => {
    // 350 -> 10 is +20 the short way, not -340.
    expect(shortestAngleDeltaDeg(350, 10)).toBe(20);
    // 10 -> 350 is -20 the short way, not +340.
    expect(shortestAngleDeltaDeg(10, 350)).toBe(-20);
  });

  it("normalizes the half-turn to +180 (never -180)", () => {
    expect(shortestAngleDeltaDeg(0, 180)).toBe(180);
    expect(shortestAngleDeltaDeg(0, -180)).toBe(180);
    expect(shortestAngleDeltaDeg(180, 0)).toBe(180);
  });
});

describe("lerpAngleDeg", () => {
  it("returns the endpoints at t=0 and t=1", () => {
    expect(lerpAngleDeg(20, 80, 0)).toBe(20);
    expect(lerpAngleDeg(20, 80, 1)).toBe(80);
  });

  it("interpolates along the shortest arc", () => {
    expect(lerpAngleDeg(20, 80, 0.5)).toBe(50);
    // Across the wrap: 350 -> 10 at half is 360 (i.e. 0), via +20*0.5 = +10.
    expect(lerpAngleDeg(350, 10, 0.5)).toBe(360);
  });

  it("clamps t outside [0,1]", () => {
    expect(lerpAngleDeg(20, 80, -1)).toBe(20);
    expect(lerpAngleDeg(20, 80, 5)).toBe(80);
  });
});

describe("smoothingFactor", () => {
  it("snaps when tau is non-positive", () => {
    expect(smoothingFactor(16, 0)).toBe(1);
    expect(smoothingFactor(16, -10)).toBe(1);
  });

  it("is 0 for non-positive dt", () => {
    expect(smoothingFactor(0, 70)).toBe(0);
    expect(smoothingFactor(-5, 70)).toBe(0);
  });

  it("is in (0,1) for normal frames and increases with dt", () => {
    const f16 = smoothingFactor(16, 70);
    const f50 = smoothingFactor(50, 70);
    expect(f16).toBeGreaterThan(0);
    expect(f16).toBeLessThan(1);
    expect(f50).toBeGreaterThan(f16);
    // 1 - e^(-50/70) ≈ 0.51
    expect(f50).toBeCloseTo(1 - Math.exp(-50 / 70), 6);
  });
});
