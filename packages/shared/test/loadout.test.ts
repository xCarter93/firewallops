import { describe, it, expect } from "vitest";
import {
  SHOT_1,
  SHOT_2,
  TROJAN,
  LOADOUT,
  expandFork,
  BARREL_LEN,
  muzzleOffset,
} from "../src/index.js";
import type { ShotInput } from "../src/types.js";

// NET-01 / Agreed Concern #1 suite (Phase 3, plan 01). Locks the hoisted shot
// catalog scalars against accidental retune during the client→shared move, the
// fork geometry, and the muzzle-tip launch math the server authority mirrors.
// Bare-Node Vitest (no jsdom): the loadout is pure data + Math.

const AIM: ShotInput = {
  x: 0,
  y: 0,
  angleDeg: 45,
  power: 100,
  wind: 0,
  gravity: 9.8,
  projectile: SHOT_1,
};

describe("hoisted loadout scalars (NET-01)", () => {
  it("loadout scalars match the Phase 2 anchors", () => {
    expect(SHOT_1.blastRadius).toBe(36);
    expect(SHOT_1.maxDamage).toBe(30);

    expect(SHOT_2.subProjectileCount).toBe(3);
    expect(SHOT_2.spread).toBe(16);
    expect(SHOT_2.blastRadius).toBe(28);

    expect(TROJAN.blastRadius).toBe(56);
    expect(TROJAN.turnDelay).toBe(40);

    // Every def shares the tuned launch scale.
    expect(SHOT_1.powerScale).toBe(2);
    expect(SHOT_2.powerScale).toBe(2);
    expect(TROJAN.powerScale).toBe(2);

    // The registry resolves each id to its def.
    expect(LOADOUT["shot-1"]).toBe(SHOT_1);
    expect(LOADOUT["shot-2"]).toBe(SHOT_2);
    expect(LOADOUT.trojan).toBe(TROJAN);
  });
});

describe("expandFork (NET-01)", () => {
  it("expandFork fans shot-2 into 3 symmetric sub-shots", () => {
    const subs = expandFork({ ...AIM, angleDeg: 45 }, SHOT_2);
    expect(subs).toHaveLength(3);
    // Center sub keeps the aim angle; outer subs offset by ±spread/2 (±8°).
    expect(subs[0].angleDeg).toBeCloseTo(45 - 8, 10);
    expect(subs[1].angleDeg).toBeCloseTo(45, 10);
    expect(subs[2].angleDeg).toBeCloseTo(45 + 8, 10);
  });

  it("expandFork returns a single shot for a non-forking def", () => {
    expect(expandFork(AIM, SHOT_1)).toHaveLength(1);
  });
});

describe("muzzleOffset launch geometry (NET-01)", () => {
  it("muzzleOffset returns the barrel tip", () => {
    expect(BARREL_LEN).toBe(22);

    // 0° = straight right: +BARREL_LEN on x, no y change.
    const right = muzzleOffset(100, 100, 0);
    expect(right.x).toBeCloseTo(122, 10);
    expect(right.y).toBeCloseTo(100, 10);

    // 90° = up: −BARREL_LEN on y under the single-negation y-down convention.
    const up = muzzleOffset(100, 100, 90);
    expect(up.x).toBeCloseTo(100, 10);
    expect(up.y).toBeCloseTo(78, 10);
  });
});
