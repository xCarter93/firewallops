import { describe, it, expect } from "vitest";
import { simulateTrajectory, powerToSpeed } from "../src/ballistics.js";
import { TerrainMask } from "../src/terrain.js";
import type { MapDef, ProjectileDef, ShotInput } from "../src/types.js";

// SIM-01 suite (Phase 1, plan 03): the integrator is a fixed-step (dt = 1/120)
// semi-implicit Euler that routes every per-step force through the pluggable
// ProjectileBehavior hook. These tests integrate against the REAL procedural
// TerrainMask (plan 02) — no flat-ground fallback.

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
    const roseThenFell = dys.some((d) => d < 0) && dys.some((d) => d > 0);
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

  it("the first integration step matches hand-computed semi-implicit Euler values", () => {
    // All-air terrain at the launch point so no collision interferes on step 0.
    const terrain = new TerrainMask(64, 64, new Uint8Array(64 * 64));
    const power = 50;
    const angleDeg = 30;
    const wind = 12;
    const gravity = 300;
    const launchX = 10;
    const launchY = 20;
    const dt = 1 / 120;

    const input = shot({
      x: launchX,
      y: launchY,
      angleDeg,
      power,
      wind,
      gravity,
    });
    const { path } = simulateTrajectory(input, terrain);

    // Hand-computed semi-implicit (velocity-before-position) first step.
    const speed = powerToSpeed(power, DEFAULT_DEF);
    const rad = (angleDeg * Math.PI) / 180;
    const vx0 = Math.cos(rad) * speed;
    const vy0 = -Math.sin(rad) * speed;
    const vx1 = vx0 + wind * dt;
    const vy1 = vy0 + gravity * dt;
    const x1 = launchX + vx1 * dt;
    const y1 = launchY + vy1 * dt;

    expect(path[0].x).toBeCloseTo(x1, 6);
    expect(path[0].y).toBeCloseTo(y1, 6);
    expect(path[0].t).toBeCloseTo(0, 6);
  });

  it("a max-power horizontal shot does not tunnel through a thin (2px) terrain column", () => {
    // Build terrain that is all-air EXCEPT a 2px-wide solid column at x in [200,201].
    const width = 512;
    const height = 64;
    const bits = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      bits[y * width + 200] = 1;
      bits[y * width + 201] = 1;
    }
    const terrain = new TerrainMask(width, height, bits);

    // Max-power (~2px/step) horizontal shot fired from the left toward the column.
    const input = shot({
      x: 100,
      y: 30,
      angleDeg: 0, // horizontal, no vertical motion
      power: 100,
      wind: 0,
      gravity: 0,
      projectile: { ...DEFAULT_DEF, powerScale: 1 },
    });
    const { impact } = simulateTrajectory(input, terrain);

    // The shot must HIT the sliver, not skip through it.
    expect(impact).not.toBeNull();
    expect(impact!.x).toBeGreaterThanOrEqual(199);
    expect(impact!.x).toBeLessThanOrEqual(203);
  });
});

describe("pluggable flight-hook seam proof", () => {
  it("an alternate (windCoupled) behavior produces a path that DIFFERS from the default for identical kinematics", () => {
    const terrain = TerrainMask.fromMap(MAP);

    // Non-zero wind so the velocity-coupled term in windCoupled actually bites.
    const base = shot({ wind: 60 });
    const defaultPath = simulateTrajectory(base, terrain).path;

    const altDef: ProjectileDef = { ...DEFAULT_DEF, behavior: "windCoupled" };
    const altPath = simulateTrajectory(
      shot({ wind: 60, projectile: altDef }),
      terrain,
    ).path;

    // If the integrator routed through a hardcoded default instead of the
    // behavior hook, these would be identical. They must differ — proving the
    // seam is real.
    expect(altPath).not.toEqual(defaultPath);
  });
});

describe("golden trajectory snapshot (regression lock)", () => {
  it("matches a rounded, downsampled projection of a fixed shot's path", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const { path } = simulateTrajectory(
      shot({ x: 100, y: 300, angleDeg: 50, power: 70, wind: 20, gravity: 300 }),
      terrain,
    );

    // Brittle-proof per RESEARCH Pitfall 3: snapshot ROUNDED ints, downsampled
    // to every 8th point — never full-precision floats (trailing-digit churn).
    const projection = path
      .filter((_, i) => i % 8 === 0)
      .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));

    expect(projection).toMatchSnapshot();
  });
});
