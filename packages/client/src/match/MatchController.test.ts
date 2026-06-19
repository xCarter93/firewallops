import { describe, it, expect } from "vitest";
import { TerrainMask, simulateTrajectory } from "@shared/sim";
import type { MapDef, Mech } from "@shared/sim";
import { MatchController } from "./MatchController.js";
import { createInitialState } from "./MatchState.js";
import { buildShotInput } from "./aim.js";
import { SHOT_1, SHOT_2, TROJAN } from "./loadout.js";

/**
 * Seam suite (Wave 0, 02-VALIDATION) — PLAY-01/02/04/06/07/08 + shotResult shape.
 *
 * Headless: imports only @shared/sim and sibling match modules (no phaser).
 */

const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

/** Fresh mask per test — resolveShot MUTATES it. */
function freshTerrain(): TerrainMask {
  return TerrainMask.fromMap(MAP);
}

/** A firing mech at the harness launch position. */
function firingMech(id: string): Mech {
  return { id, x: 100, y: 300, hp: 100 };
}

/**
 * Place a target mech exactly where a given aim's primary arc lands, so the
 * blast is guaranteed to register a direct hit regardless of map tuning.
 */
function targetAtImpact(id: string, aim: Parameters<typeof simulateTrajectory>[0], terrain: TerrainMask): Mech {
  const { impact } = simulateTrajectory(aim, terrain);
  if (!impact) throw new Error("test aim did not land — adjust fixture");
  return { id, x: impact.x, y: impact.y, hp: 100 };
}

/** Standard landing aim (mirrors the harness shot). */
function landingAim(mech: Mech, def = SHOT_1) {
  return buildShotInput({
    mech,
    angleDeg: 30,
    power: 70,
    wind: 60,
    gravity: 300,
    def,
  });
}

describe("MatchController seam", () => {
  it("PLAY-01: buildShotInput maps fields and position correctly", () => {
    const mech = firingMech("p1");
    const input = buildShotInput({
      mech,
      angleDeg: 45,
      power: 70,
      wind: 30,
      gravity: 300,
      def: SHOT_1,
    });
    expect(input.x).toBe(mech.x);
    expect(input.y).toBe(mech.y);
    expect(input.angleDeg).toBe(45);
    expect(input.power).toBe(70);
    expect(input.wind).toBe(30);
    expect(input.gravity).toBe(300);
    expect(input.projectile).toBe(SHOT_1);
  });

  it("PLAY-01 facing: facing -1 mirrors the relative angle to 180 - angle; facing 1 is unchanged", () => {
    const mech = firingMech("p1");
    const base = {
      mech,
      power: 70,
      wind: 0,
      gravity: 300,
      def: SHOT_1,
    };

    // Facing right (default / explicit 1): the absolute angle == the relative.
    expect(buildShotInput({ ...base, angleDeg: 30 }).angleDeg).toBe(30);
    expect(buildShotInput({ ...base, angleDeg: 30, facing: 1 }).angleDeg).toBe(30);

    // Facing left (-1): mirrored across the vertical (30 -> 150, 90 -> 90, 0 -> 180).
    expect(buildShotInput({ ...base, angleDeg: 30, facing: -1 }).angleDeg).toBe(150);
    expect(buildShotInput({ ...base, angleDeg: 90, facing: -1 }).angleDeg).toBe(90);
    expect(buildShotInput({ ...base, angleDeg: 0, facing: -1 }).angleDeg).toBe(180);
  });

  it("Test A: applyShot returns the ShotResult shape and mutates HP (PLAY-08)", () => {
    const terrain = freshTerrain();
    const shooter = firingMech("p1");
    const aim = landingAim(shooter, SHOT_1);
    const target = targetAtImpact("p2", aim, terrain);

    const state = createInitialState([shooter, target], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    const before = target.hp;
    const result = mc.applyShot(aim, SHOT_1);

    expect(result).toHaveProperty("path");
    expect(result).toHaveProperty("impact");
    expect(result).toHaveProperty("carves");
    expect(result).toHaveProperty("damage");
    expect(result.path.length).toBeGreaterThan(0);

    const dealt = result.damage
      .filter((d) => d.mechId === "p2")
      .reduce((a, d) => a + d.amount, 0);
    expect(dealt).toBeGreaterThan(0);
    expect(target.hp).toBe(Math.max(0, before - dealt));
  });

  it("Test B: SHOT_2 fork produces multiple carves (PLAY-04 multi-carve)", () => {
    const terrain = freshTerrain();
    const shooter = firingMech("p1");
    const aim = landingAim(shooter, SHOT_2);
    const target = targetAtImpact("p2", aim, terrain);

    const state = createInitialState([shooter, target], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    const result = mc.applyShot(aim, SHOT_2);
    expect(result.carves.length).toBeGreaterThanOrEqual(2);
  });

  it("Test C: delay queue picks lowest-delay-next and lets a low-delay player act twice (PLAY-06)", () => {
    const terrain = freshTerrain();
    const p1Mech = firingMech("p1");
    const p2Mech: Mech = { id: "p2", x: 900, y: 300, hp: 100 };
    const state = createInitialState([p1Mech, p2Mech], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    // P1 (active) fires a low-delay SHOT_1 (+10).
    expect(state.activePlayerId).toBe("p1");
    mc.applyShot(buildShotInput({ mech: p1Mech, angleDeg: 45, power: 50, wind: 0, gravity: 300, def: SHOT_1 }), SHOT_1);
    expect(state.players[0].accumulatedDelay).toBe(10);

    // P2's turn: fires a high-delay Trojan (+40).
    state.activePlayerId = "p2";
    mc.applyShot(buildShotInput({ mech: p2Mech, angleDeg: 135, power: 50, wind: 0, gravity: 300, def: TROJAN }), TROJAN);
    expect(state.players[1].accumulatedDelay).toBe(40);

    // advanceTurn -> lower accumulated delay is P1 (10 < 40).
    mc.advanceTurn();
    expect(state.activePlayerId).toBe("p1");

    // P1 fires again low-delay (+10 => 20), still below P2's 40.
    mc.applyShot(buildShotInput({ mech: p1Mech, angleDeg: 45, power: 50, wind: 0, gravity: 300, def: SHOT_1 }), SHOT_1);
    mc.advanceTurn();
    expect(state.activePlayerId).toBe("p1"); // acted twice before P2
  });

  it("Test D: checkWin declares last mech standing (PLAY-07)", () => {
    const terrain = freshTerrain();
    const a: Mech = { id: "p1", x: 100, y: 300, hp: 100 };
    const b: Mech = { id: "p2", x: 900, y: 300, hp: 100 };
    const state = createInitialState([a, b], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    expect(mc.checkWin()).toBeNull(); // both alive

    b.hp = 0;
    expect(mc.checkWin()).toBe("p1");
  });

  it("Test E: SS arms at 3 hits and resets when the Trojan fires", () => {
    const terrain = freshTerrain();
    const shooter = firingMech("p1");
    const aim = landingAim(shooter, SHOT_1);
    const target = targetAtImpact("p2", aim, terrain);
    target.hp = 10_000; // keep it alive across repeated hits

    const state = createInitialState([shooter, target], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    // Each identical shot carves the mask in place, drifting the impact into the
    // growing crater; re-seat the target on the current impact so every shot
    // lands a damaging hit (the mechanic under test is "3 landing hits → armed").
    function fireLandingShot1() {
      const a = landingAim(shooter, SHOT_1);
      const { impact } = simulateTrajectory(a, terrain);
      if (!impact) throw new Error("aim stopped landing — adjust fixture");
      target.x = impact.x;
      target.y = impact.y;
      mc.applyShot(a, SHOT_1);
    }

    expect(mc.isSSArmed("p1")).toBe(false);
    fireLandingShot1();
    fireLandingShot1();
    expect(mc.isSSArmed("p1")).toBe(false);
    fireLandingShot1();
    expect(mc.isSSArmed("p1")).toBe(true);

    // Firing the Trojan resets the charge.
    const trojanAim = buildShotInput({ mech: shooter, angleDeg: 30, power: 70, wind: 60, gravity: 300, def: TROJAN });
    mc.applyShot(trojanAim, TROJAN);
    expect(mc.isSSArmed("p1")).toBe(false);
    expect(state.players[0].ssHitCharge).toBe(0);
  });

  it("Test F: previewTrajectory is non-empty and wind-reactive (PLAY-02)", () => {
    const terrain = freshTerrain();
    const shooter = firingMech("p1");
    const state = createInitialState([shooter], [{ id: "p1" }]);
    const mc = new MatchController(terrain, state);

    const noWind = mc.previewTrajectory(
      buildShotInput({ mech: shooter, angleDeg: 60, power: 90, wind: 0, gravity: 300, def: SHOT_1 }),
    );
    const highWind = mc.previewTrajectory(
      buildShotInput({ mech: shooter, angleDeg: 60, power: 90, wind: 80, gravity: 300, def: SHOT_1 }),
    );

    expect(noWind.length).toBeGreaterThan(0);
    expect(highWind.length).toBeGreaterThan(0);

    // Wind shifts the path horizontally: compare the last common sample's x.
    const n = Math.min(noWind.length, highWind.length);
    const lastNo = noWind[n - 1].x;
    const lastWind = highWind[n - 1].x;
    expect(Math.abs(lastWind - lastNo)).toBeGreaterThan(1);
  });

  it("rollWind stays within [WIN_MIN, WIN_MAX] with a seeded rng", () => {
    const terrain = freshTerrain();
    const state = createInitialState([firingMech("p1")], [{ id: "p1" }]);
    const mc = new MatchController(terrain, state);
    mc.rollWind(() => 0);
    expect(state.wind).toBe(-80);
    mc.rollWind(() => 1);
    expect(state.wind).toBe(80);
    mc.rollWind(() => 0.5);
    expect(state.wind).toBeCloseTo(0, 6);
  });
});
