import { describe, it, expect } from "vitest";
import { TerrainMask, SHOT_1, muzzleOffset } from "@shared/sim";
import type { ShotInput } from "@shared/sim";
import { MAP } from "../src/match/world.js";
import { runServerShot, type ServerMech } from "../src/match/resolve.js";
import { GRAVITY } from "../src/config.js";

/**
 * NET-01 — runServerShot returns the frozen ShotResult shape.
 *
 * Builds a server-side TerrainMask from the server MAP, fires SHOT_1 from a
 * known barrel-tip origin, and asserts the returned object has exactly the
 * `path`/`impact`/`carves`/`damage` keys, with carves as integer
 * `{cx,cy,r}` records and damage as `{mechId, amount}` records.
 */
describe("resolve: shotResult shape", () => {
  it("returns exactly path/impact/carves/damage with the right element shapes", () => {
    const terrain = TerrainMask.fromMap(MAP);

    // A short-range, high-power downward arc at an opponent sitting close by, so
    // the shot lands in-bounds and craters the ground (non-empty carves).
    const shooterX = 980;
    const shooterY = 360;
    const origin = muzzleOffset(shooterX, shooterY, 60);
    const aim: ShotInput = {
      x: origin.x,
      y: origin.y,
      angleDeg: 60,
      power: 70,
      wind: 0,
      gravity: GRAVITY,
      projectile: SHOT_1,
    };

    const mechs: ServerMech[] = [
      { id: "a", x: shooterX, y: shooterY, hp: 100 },
      { id: "b", x: 1140, y: 405, hp: 100 },
    ];

    const result = runServerShot(aim, SHOT_1, terrain, mechs);

    // Exactly these four keys, nothing more.
    expect(Object.keys(result).sort()).toEqual(
      ["carves", "damage", "impact", "path"].sort(),
    );

    // path is a non-empty sampled arc of {x,y,t}.
    expect(Array.isArray(result.path)).toBe(true);
    expect(result.path.length).toBeGreaterThan(0);
    for (const p of result.path) {
      expect(typeof p.x).toBe("number");
      expect(typeof p.y).toBe("number");
      expect(typeof p.t).toBe("number");
    }

    // The shot lands on the ground → at least one quantized integer crater.
    expect(Array.isArray(result.carves)).toBe(true);
    expect(result.carves.length).toBeGreaterThan(0);
    for (const c of result.carves) {
      expect(Number.isInteger(c.cx)).toBe(true);
      expect(Number.isInteger(c.cy)).toBe(true);
      expect(Number.isInteger(c.r)).toBe(true);
    }

    // damage entries are {mechId, amount}.
    expect(Array.isArray(result.damage)).toBe(true);
    for (const d of result.damage) {
      expect(typeof d.mechId).toBe("string");
      expect(typeof d.amount).toBe("number");
    }
  });
});
