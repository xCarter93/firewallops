import { describe, it, expect } from "vitest";
import {
  DEFAULT_BEHAVIOR,
  getBehavior,
} from "../src/projectile.js";
import type {
  Damage,
  FlightContext,
  FlightState,
  ProjectileDef,
  ShotInput,
} from "../src/types.js";

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

function shot(overrides: Partial<ShotInput> = {}): ShotInput {
  return {
    x: 100,
    y: 300,
    angleDeg: 45,
    power: 60,
    wind: 0,
    gravity: 300,
    projectile: DEF,
    ...overrides,
  };
}

const ctx: FlightContext = { wind: 12, gravity: 300, t: 0, step: 0 };
const state: FlightState = { x: 100, y: 300, vx: 50, vy: -50 };

describe("ProjectileBehavior registry (pluggable seam)", () => {
  it("DEFAULT_BEHAVIOR.step returns plain wind+gravity (does not read mass/drag)", () => {
    const f = DEFAULT_BEHAVIOR.step(state, ctx, DEF);
    expect(f.fx).toBe(ctx.wind);
    expect(f.fy).toBe(ctx.gravity);

    // mass/drag are reserved: changing them must not change the default force.
    const heavy: ProjectileDef = { ...DEF, mass: 99, drag: 99 };
    const f2 = DEFAULT_BEHAVIOR.step(state, ctx, heavy);
    expect(f2.fx).toBe(ctx.wind);
    expect(f2.fy).toBe(ctx.gravity);
  });

  it("DEFAULT_BEHAVIOR.createSubShots is a single-shot passthrough", () => {
    const input = shot();
    const subs = DEFAULT_BEHAVIOR.createSubShots(input, DEF);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toBe(input);
  });

  it("DEFAULT_BEHAVIOR.combineDamage sums per mechId across sub-impacts", () => {
    const perImpact: Damage[][] = [
      [
        { mechId: "a", amount: 10 },
        { mechId: "b", amount: 5 },
      ],
      [{ mechId: "a", amount: 7 }],
    ];
    const combined = DEFAULT_BEHAVIOR.combineDamage(perImpact, DEF);
    const a = combined.find((d) => d.mechId === "a");
    const b = combined.find((d) => d.mechId === "b");
    expect(a?.amount).toBe(17);
    expect(b?.amount).toBe(5);
  });

  it("combineDamage passes a single-impact list through unchanged", () => {
    const perImpact: Damage[][] = [[{ mechId: "a", amount: 12 }]];
    const combined = DEFAULT_BEHAVIOR.combineDamage(perImpact, DEF);
    expect(combined).toEqual([{ mechId: "a", amount: 12 }]);
  });

  it("getBehavior resolves the default and the alternate, and falls back on unknown", () => {
    expect(getBehavior("default")).toBe(DEFAULT_BEHAVIOR);
    const alt = getBehavior("windCoupled");
    expect(alt).not.toBe(DEFAULT_BEHAVIOR);
    // Unknown key falls back to the default (?? DEFAULT_BEHAVIOR).
    expect(getBehavior("nope-not-registered")).toBe(DEFAULT_BEHAVIOR);
  });

  it("the alternate behavior's step diverges from the default for identical inputs", () => {
    const alt = getBehavior("windCoupled");
    const moving: FlightState = { x: 0, y: 0, vx: 80, vy: -40 };
    const def = DEFAULT_BEHAVIOR.step(moving, ctx, DEF);
    const altF = alt.step(moving, ctx, DEF);
    // At least one force component must differ — the seam is not hardcoded.
    const differs = def.fx !== altF.fx || def.fy !== altF.fy;
    expect(differs).toBe(true);
  });
});
