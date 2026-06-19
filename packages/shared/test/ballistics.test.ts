import { describe, it, expect } from "vitest";
import { simulateTrajectory } from "../src/ballistics.js";
import { TerrainMask } from "../src/terrain.js";
import type { MapDef, ProjectileDef, ShotInput } from "../src/types.js";

// RED scaffold (Phase 1, plan 01): the implementation modules are throw-stubs,
// so every behavioral call below throws at runtime. Implementations land in
// plan 02. The suite typechecks (stubs make every import resolve) but is red.

const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 1,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

const DEFAULT_DEF: ProjectileDef = {
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
    projectile: DEFAULT_DEF,
    ...overrides,
  };
}

describe("simulateTrajectory (SIM-01)", () => {
  it("produces a wind+gravity arc (not a straight line) with an apex and a turning point in vy", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const { path } = simulateTrajectory(shot(), terrain);

    expect(path.length).toBeGreaterThan(2);

    // Apex: some point's y is above (smaller y, since y is screen-down) the launch y.
    const minY = Math.min(...path.map((p) => p.y));
    expect(minY).toBeLessThan(300);

    // Lands at a different x than launch (motion happened).
    const last = path[path.length - 1];
    expect(last.x).not.toBeCloseTo(100, 1);

    // Not a straight line: the vertical velocity must change sign (rise then
    // fall), i.e. the path has a turning point in vy.
    const dys = path.slice(1).map((p, i) => p.y - path[i].y);
    const roseThenFell =
      dys.some((d) => d < 0) && dys.some((d) => d > 0);
    expect(roseThenFell).toBe(true);
  });

  it("wind shifts the landing point: positive wind lands at a greater x than the no-wind baseline", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const baseline = simulateTrajectory(shot({ wind: 0 }), terrain);
    const windy = simulateTrajectory(shot({ wind: 80 }), terrain);

    const baselineX = baseline.path[baseline.path.length - 1].x;
    const windyX = windy.path[windy.path.length - 1].x;
    expect(windyX).toBeGreaterThan(baselineX);
  });
});

describe("pluggable flight-hook seam proof", () => {
  it("an alternate behavior produces a path that DIFFERS from the default for identical kinematics", () => {
    const terrain = TerrainMask.fromMap(MAP);

    const defaultPath = simulateTrajectory(shot(), terrain).path;
    const altDef: ProjectileDef = { ...DEFAULT_DEF, behavior: "alt-windrider" };
    const altPath = simulateTrajectory(
      shot({ projectile: altDef }),
      terrain,
    ).path;

    // If the integrator routed through a hardcoded default instead of the
    // behavior hook, these would be identical. They must differ — proving the
    // seam is real.
    expect(altPath).not.toEqual(defaultPath);
  });
});
