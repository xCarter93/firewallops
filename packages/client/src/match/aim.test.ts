import { describe, it, expect } from "vitest";
import { TerrainMask, simulateTrajectory } from "@shared/sim";
import type { MapDef } from "@shared/sim";
import { buildShotInput } from "./aim.js";
import { SHOT_1 } from "./loadout.js";

/**
 * Team-B shot-direction proof (NET-06).
 *
 * Headless seam test — no phaser (the ESLint guard under src/match/** bans it).
 * The networked fire path (MatchScene.fireNetworked) now passes the local
 * player's server-synced facing into buildShotInput instead of a hardcoded
 * facing 1. This exercises that exact seam — buildShotInput → the absolute sim
 * angle → simulateTrajectory — and asserts a Team-B player (on the right,
 * facing -1) actually fires toward Team A (lower x). The old hardcoded facing 1
 * sent the right-side shot the WRONG way (toward higher x); case 1 pins that.
 */

const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

function freshTerrain(): TerrainMask {
  return TerrainMask.fromMap(MAP);
}

describe("aim direction (NET-06 Team-B fix)", () => {
  it("NET-06: a Team-B shot (facing -1) travels toward Team A (lower x)", () => {
    const terrain = freshTerrain();
    const startX = 800; // Team B's side (right)
    const startY = 300;

    const aim = buildShotInput({
      mech: { id: "teamB", x: startX, y: startY, hp: 100 },
      angleDeg: 45,
      power: 70,
      wind: 0,
      gravity: 300,
      def: SHOT_1,
      facing: -1,
    });

    const { path } = simulateTrajectory(aim, terrain);
    expect(path.length).toBeGreaterThan(2);

    // Already moving left at an early sample, and ends left of the launch point.
    expect(path[2].x).toBeLessThan(startX);
    expect(path[path.length - 1].x).toBeLessThan(startX);

    // Genuine FIX-1 guard (not a tautology): the OLD hardcoded facing 1 would
    // have sent the SAME right-side shot the wrong way — toward higher x.
    const buggyAim = buildShotInput({
      mech: { id: "teamB", x: startX, y: startY, hp: 100 },
      angleDeg: 45,
      power: 70,
      wind: 0,
      gravity: 300,
      def: SHOT_1,
      facing: 1,
    });
    const buggy = simulateTrajectory(buggyAim, terrain);
    expect(buggy.path[buggy.path.length - 1].x).toBeGreaterThan(startX);
  });

  it("regression: a Team-A shot (facing 1) still travels toward Team B (higher x)", () => {
    const terrain = freshTerrain();
    const startX = 200; // Team A's side (left)
    const startY = 300;

    const aim = buildShotInput({
      mech: { id: "teamA", x: startX, y: startY, hp: 100 },
      angleDeg: 45,
      power: 70,
      wind: 0,
      gravity: 300,
      def: SHOT_1,
      facing: 1,
    });

    const { path } = simulateTrajectory(aim, terrain);
    expect(path.length).toBeGreaterThan(2);
    expect(path[2].x).toBeGreaterThan(startX);
    expect(path[path.length - 1].x).toBeGreaterThan(startX);
  });

  it("the two facings are mirror images at the buildShotInput layer", () => {
    const base = {
      mech: { id: "m", x: 500, y: 300, hp: 100 },
      power: 70,
      wind: 0,
      gravity: 300,
      def: SHOT_1,
    };
    const right = buildShotInput({ ...base, angleDeg: 45, facing: 1 });
    const left = buildShotInput({ ...base, angleDeg: 45, facing: -1 });
    // Ties the trajectory proof back to the unit conversion fireNetworked relies on.
    expect(left.angleDeg).toBe(180 - right.angleDeg);
  });
});
