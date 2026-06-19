import { describe, it, expect } from "vitest";
import { blastDamage } from "@shared/sim";
import type { ShotInput } from "@shared/sim";
import { SHOT_1, SHOT_2, TROJAN, expandFork } from "./loadout.js";

/**
 * Loadout suite (Wave 0, 02-VALIDATION) — PLAY-04 the 1/2/Trojan content.
 *
 * Asserts the data-driven loadout shape and the CLIENT-SIDE fork expander
 * (research A1: the sim's behavior registry is private, so Shot 2's fork is
 * achieved by client expansion, not a sim behavior swap).
 */

/** Minimal aim fixture, projectile filled in per test. */
function aimFor(def: ShotInput["projectile"]): ShotInput {
  return {
    x: 100,
    y: 300,
    angleDeg: 45,
    power: 70,
    wind: 0,
    gravity: 300,
    projectile: def,
  };
}

describe("loadout", () => {
  it("Test 1: SHOT_2 forks (subProjectileCount 2-3, positive spread)", () => {
    expect(SHOT_2.subProjectileCount).toBeGreaterThanOrEqual(2);
    expect(SHOT_2.subProjectileCount).toBeLessThanOrEqual(3);
    expect(SHOT_2.spread ?? 0).toBeGreaterThan(0);
  });

  it("Test 2: expandFork(SHOT_2) fans into N distinct, symmetric angles", () => {
    const aim = aimFor(SHOT_2);
    const subs = expandFork(aim, SHOT_2);
    expect(subs.length).toBe(SHOT_2.subProjectileCount);

    const angles = subs.map((s) => s.angleDeg);
    // distinct
    expect(new Set(angles).size).toBe(angles.length);
    // symmetric about the input angle: mean of offsets ~ 0
    const mean = angles.reduce((a, b) => a + b, 0) / angles.length;
    expect(mean).toBeCloseTo(aim.angleDeg, 6);
    // each sub keeps the def as its projectile
    for (const s of subs) expect(s.projectile).toBe(SHOT_2);
  });

  it("Test 3: expandFork(SHOT_1) is a single packet (no fork)", () => {
    const aim = aimFor(SHOT_1);
    const subs = expandFork(aim, SHOT_1);
    expect(subs.length).toBe(1);
    expect(subs[0].angleDeg).toBe(aim.angleDeg);
    expect(subs[0].projectile).toBe(SHOT_1);
  });

  it("Test 4: Trojan dead-center damage and blast both exceed Shot 1", () => {
    expect(blastDamage(0, TROJAN)).toBeGreaterThan(blastDamage(0, SHOT_1));
    expect(TROJAN.blastRadius).toBeGreaterThan(SHOT_1.blastRadius);
  });

  it("Test 5: turnDelay ordering Shot1 < Shot2 < Trojan (damage-vs-tempo)", () => {
    expect(SHOT_1.turnDelay).toBeLessThan(SHOT_2.turnDelay);
    expect(SHOT_2.turnDelay).toBeLessThan(TROJAN.turnDelay);
  });

  it("Test 6: dead-center damage stays within Phase 1 lethality anchors", () => {
    const shot1Center = blastDamage(0, SHOT_1);
    expect(shot1Center).toBeGreaterThanOrEqual(25);
    expect(shot1Center).toBeLessThanOrEqual(50);
    expect(blastDamage(0, TROJAN)).toBeLessThanOrEqual(60);
  });
});
