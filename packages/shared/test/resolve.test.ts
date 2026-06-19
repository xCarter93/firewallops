import { describe, it, expect } from "vitest";
import { resolveShot, blastDamage } from "../src/resolve.js";
import { TerrainMask } from "../src/terrain.js";
import { simulateTrajectory } from "../src/ballistics.js";
import type { MapDef, Mech, ProjectileDef, ShotInput } from "../src/types.js";

// SIM-03 — distance-scaled blast damage. These are RANGE assertions, never
// exact-value snapshots: the damage numbers move when Phase 2 owns real balance.
// Only stable geometry (the mask) is compared byte-for-byte (the parity case).

const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

// TEST ANCHORS ONLY (Phase 2 owns real balance). Tuned so a direct hit strictly
// between directHitThreshold and blastRadius lands ~25-35 HP, and a dead-center
// hit (with the bonus) lands ~50 HP.
//   maxDamage*(1 - 7/60)  = 30 * 0.8833 ≈ 26.5  (in [25,35], bonus excluded)
//   maxDamage*(1 - 0/60) + bonus = 30 + 18 = 48  (~50, bonus applied)
const DEF: ProjectileDef = {
  id: "default-shell",
  behavior: "default",
  maxDamage: 30,
  blastRadius: 60,
  grazeFloor: 5,
  directHitThreshold: 6,
  directHitBonus: 18,
  powerScale: 1,
  mass: 1,
  drag: 0,
  turnDelay: 0,
};

// A shot aimed to impact down-range; gravity pulls it into the ground.
const SHOT: ShotInput = {
  x: 100,
  y: 300,
  angleDeg: 30,
  power: 70,
  wind: 0,
  gravity: 300,
  projectile: DEF,
};

describe("blastDamage falloff (SIM-03)", () => {
  it("damage scales with distance: center > edge", () => {
    expect(blastDamage(5, DEF)).toBeGreaterThan(blastDamage(50, DEF));
  });

  it("any in-radius hit deals at least the graze floor", () => {
    expect(blastDamage(DEF.blastRadius - 1, DEF)).toBeGreaterThanOrEqual(
      DEF.grazeFloor,
    );
  });

  it("outside the radius deals zero", () => {
    expect(blastDamage(DEF.blastRadius + 1, DEF)).toBe(0);
    expect(blastDamage(DEF.blastRadius, DEF)).toBe(0);
  });

  it("a direct hit BETWEEN directHitThreshold and blastRadius lands in the ~25-35 anchor (bonus NOT applied)", () => {
    // Strictly past the threshold so the bonus branch is unambiguously excluded.
    const dmg = blastDamage(DEF.directHitThreshold + 1, DEF);
    expect(dmg).toBeGreaterThanOrEqual(25);
    expect(dmg).toBeLessThanOrEqual(35);
  });

  it("a dead-center hit (inside directHitThreshold) lands ~50 with the bonus", () => {
    const dmg = blastDamage(0, DEF);
    // ~50 anchor with a tolerance band (NOT exact equality).
    expect(dmg).toBeGreaterThanOrEqual(45);
    expect(dmg).toBeLessThanOrEqual(55);
  });
});

describe("resolveShot (SIM-03)", () => {
  it("returns array-shaped carves[]/damage[] and a mech near impact loses more scaled HP than a far mech", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const { impact } = simulateImpact(SHOT, terrain);

    // Place both mechs INSIDE blastRadius (so the >0-only inclusion rule keeps
    // both): near right at the crater, far a bit away but still in radius.
    const near: Mech = { id: "near", x: impact.x, y: impact.y, hp: 100 };
    const far: Mech = {
      id: "far",
      x: impact.x + DEF.blastRadius * 0.6,
      y: impact.y,
      hp: 100,
    };

    const fresh = TerrainMask.fromMap(MAP);
    const result = resolveShot(SHOT, fresh, [near, far], DEF);

    expect(result.carves.length).toBeGreaterThanOrEqual(1);
    const c = result.carves[0];
    expect(Number.isInteger(c.cx)).toBe(true);
    expect(Number.isInteger(c.cy)).toBe(true);
    expect(Number.isInteger(c.r)).toBe(true);

    const nearDmg = result.damage.find((d) => d.mechId === "near")?.amount ?? 0;
    const farDmg = result.damage.find((d) => d.mechId === "far")?.amount ?? 0;
    expect(nearDmg).toBeGreaterThan(farDmg);

    // Range bounds (NOT a snapshot): >= floor, <= curve peak + bonus.
    const ceiling = DEF.maxDamage + DEF.directHitBonus;
    expect(nearDmg).toBeGreaterThanOrEqual(DEF.grazeFloor);
    expect(nearDmg).toBeLessThanOrEqual(ceiling);
  });

  it("resolve-record-vs-mask-replay parity: carves[0] replayed on a fresh clone reproduces the mutated mask byte-for-byte", () => {
    // Same MapDef → byte-identical starting bits on both masks.
    const terrain = TerrainMask.fromMap(MAP);
    const clone = TerrainMask.fromMap(MAP);

    const mechs: Mech[] = [{ id: "m", x: 0, y: 0, hp: 100 }];

    // resolveShot mutates `terrain` (server-side authoritative mask) and records
    // the integer carve it applied.
    const { carves } = resolveShot(SHOT, terrain, mechs, DEF);
    expect(carves.length).toBeGreaterThanOrEqual(1);

    // Replay the RECORDED integers independently on a fresh clone (client path).
    clone.carveCircle(carves[0].cx, carves[0].cy, carves[0].r);

    // The recorded carve, replayed on a fresh clone, reproduces the exact mask
    // resolveShot produced — no float/int drift between record and apply.
    expect(clone.bits).toEqual(terrain.bits);
  });

  it("an out-of-bounds impact yields empty carves/damage (no off-map carve or damage)", () => {
    const terrain = TerrainMask.fromMap(MAP);

    // Fire near-vertical with high power over open sky so the projectile leaves
    // the top of the map (impact null) OR lands off-map: either way no carve.
    const oob: ShotInput = {
      x: 10,
      y: 50,
      angleDeg: 88,
      power: 100,
      wind: -200,
      gravity: 0,
      projectile: DEF,
    };

    const mechs: Mech[] = [{ id: "m", x: 10, y: 50, hp: 100 }];
    const result = resolveShot(oob, terrain, mechs, DEF);

    expect(result.carves).toEqual([]);
    expect(result.damage).toEqual([]);
  });
});

// Local helper: find where the canonical SHOT lands so the test can place mechs
// relative to the real impact rather than guessing pixel coords.
function simulateImpact(
  input: ShotInput,
  terrain: TerrainMask,
): { impact: { x: number; y: number } } {
  const { impact } = simulateTrajectory(input, terrain);
  if (!impact) throw new Error("test setup: SHOT did not impact");
  return { impact };
}
