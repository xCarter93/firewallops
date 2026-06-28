import { describe, it, expect } from "vitest";
import {
  resolveDwellMs,
  RESOLVE_SETTLE_MS,
  PROJECTILE_PTS_PER_MS,
  PROJECTILE_MIN_FLIGHT_MS,
  PROJECTILE_MAX_FLIGHT_MS,
  settledY,
} from "@firewallops/match-core";

/**
 * Pure RESOLVING-dwell + settle helpers (turn-timing + gravity rework).
 *
 * resolveDwellMs mirrors the client ProjectileView flight clamp so the
 * server-driven turn advance waits for the shot to land; settledY is the
 * drop-only mech settle. Both are pure — testable with no live WS server.
 */
describe("resolveDwellMs (RESOLVING dwell mirrors client flight + settle beat)", () => {
  it("a tiny path clamps to the MIN flight + settle beat", () => {
    // 10 / 0.06 ≈ 167ms < MIN → clamps up to MIN.
    expect(resolveDwellMs(10)).toBe(PROJECTILE_MIN_FLIGHT_MS + RESOLVE_SETTLE_MS);
  });

  it("a huge path clamps to the MAX flight + settle beat", () => {
    // 1000 / 0.06 ≈ 16667ms > MAX → clamps down to MAX.
    expect(resolveDwellMs(1000)).toBe(
      PROJECTILE_MAX_FLIGHT_MS + RESOLVE_SETTLE_MS,
    );
  });

  it("a mid-range path scales linearly (flight = len / PTS_PER_MS) + beat", () => {
    // Choose a length whose flight lands strictly inside the clamp band.
    const len = Math.round(
      ((PROJECTILE_MIN_FLIGHT_MS + PROJECTILE_MAX_FLIGHT_MS) / 2) *
        PROJECTILE_PTS_PER_MS,
    );
    const flight = len / PROJECTILE_PTS_PER_MS;
    expect(flight).toBeGreaterThan(PROJECTILE_MIN_FLIGHT_MS);
    expect(flight).toBeLessThan(PROJECTILE_MAX_FLIGHT_MS);
    expect(resolveDwellMs(len)).toBeCloseTo(flight + RESOLVE_SETTLE_MS, 6);
  });

  it("is monotonic non-decreasing in path length", () => {
    let prev = -Infinity;
    for (const len of [0, 1, 30, 60, 90, 120, 300, 5000]) {
      const dwell = resolveDwellMs(len);
      expect(dwell).toBeGreaterThanOrEqual(prev);
      prev = dwell;
    }
  });

  it("always exceeds the bare settle beat (there is always some flight)", () => {
    expect(resolveDwellMs(0)).toBeGreaterThan(RESOLVE_SETTLE_MS);
  });
});

describe("settledY (drop-only mech settle, no fall damage)", () => {
  it("drops onto a lower post-carve surface", () => {
    expect(settledY(400, 460)).toBe(460);
  });

  it("never rises — ground above the mobile leaves it untouched", () => {
    expect(settledY(400, 360)).toBe(400);
  });

  it("ignores sub-pixel ground changes (no jitter)", () => {
    expect(settledY(400, 400.4)).toBe(400);
    expect(settledY(400, 400)).toBe(400);
  });

  it("settles to ground exactly at the > +0.5 threshold boundary", () => {
    // +0.5 is NOT greater-than 0.5 → held; +0.6 drops.
    expect(settledY(400, 400.5)).toBe(400);
    expect(settledY(400, 400.6)).toBe(400.6);
  });
});
