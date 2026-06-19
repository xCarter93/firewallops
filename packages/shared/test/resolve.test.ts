import { describe, it, expect } from "vitest";
import { resolveShot } from "../src/resolve.js";
import { TerrainMask } from "../src/terrain.js";
import type { MapDef, Mech, ProjectileDef, ShotInput } from "../src/types.js";

// RED scaffold (Phase 1, plan 01): resolveShot is a throw-stub. Implementation
// lands in plan 04. Tests typecheck but throw at runtime.

const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

const DEF: ProjectileDef = {
  id: "default-shell",
  behavior: "default",
  maxDamage: 30,
  blastRadius: 48,
  grazeFloor: 5,
  directHitThreshold: 6,
  directHitBonus: 20,
  powerScale: 1,
  mass: 1,
  drag: 0,
  turnDelay: 0,
};

// A shot aimed to impact near x=300, y=450.
const SHOT: ShotInput = {
  x: 100,
  y: 300,
  angleDeg: 30,
  power: 70,
  wind: 0,
  gravity: 300,
  projectile: DEF,
};

describe("resolveShot damage falloff (SIM-03)", () => {
  it("a mech near impact takes more damage than a mech far from impact (center > edge), both within tuned anchors", () => {
    const terrain = TerrainMask.fromMap(MAP);

    const near: Mech = { id: "near", x: 300, y: 450, hp: 100 };
    const far: Mech = { id: "far", x: 340, y: 450, hp: 100 };

    const { damage } = resolveShot(SHOT, terrain, [near, far], DEF);

    const nearDmg = damage.find((d) => d.mechId === "near")?.amount ?? 0;
    const farDmg = damage.find((d) => d.mechId === "far")?.amount ?? 0;

    // Distance-scaled: nearer mech takes more.
    expect(nearDmg).toBeGreaterThan(farDmg);

    // Range assertions (NOT exact-value snapshot — anchors move in Phase 2):
    // any in-radius hit is at least the graze floor and never exceeds the
    // curve peak + direct-hit bonus.
    const ceiling = DEF.maxDamage + DEF.directHitBonus;
    expect(nearDmg).toBeGreaterThanOrEqual(DEF.grazeFloor);
    expect(nearDmg).toBeLessThanOrEqual(ceiling);
  });
});
