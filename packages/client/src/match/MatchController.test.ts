import { describe, it, expect, vi } from "vitest";
import { TerrainMask, simulateTrajectory } from "@shared/sim";
import type { MapDef, Mech, ProjectileDef, ShotInput } from "@shared/sim";
import { MatchController } from "./MatchController.js";
import { createInitialState } from "./MatchState.js";
import { buildShotInput } from "./aim.js";
import { SHOT_1, SHOT_2 } from "./loadout.js";

/**
 * Seam suite (Wave 0, 02-VALIDATION + Phase 3 fire-and-forget contract).
 *
 * Headless: imports only @shared/sim and sibling match modules (no phaser).
 *
 * PHASE 3 CONTRACT CHANGE (NET-01): `applyShot` is now FIRE-AND-FORGET — it
 * forwards (aim, def) to an injected sender and returns void. It NO LONGER
 * resolves the shot, mutates HP, carves the mask, ticks SS-charge, or
 * accumulates delay (those are server-authoritative now). The tests below assert
 * the new contract (spy invoked, void return, no local HP mutation) and keep the
 * still-live methods (previewTrajectory / advanceTurn / checkWin / rollWind /
 * isSSArmed) covered for the env-gated hotseat path.
 */

const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

/** Fresh mask per test. */
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
function targetAtImpact(
  id: string,
  aim: Parameters<typeof simulateTrajectory>[0],
  terrain: TerrainMask,
): Mech {
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

  it("Test A (Phase 3): applyShot fire-and-forwards to the injected sender and returns void", () => {
    const terrain = freshTerrain();
    const shooter = firingMech("p1");
    const aim = landingAim(shooter, SHOT_1);
    const target = targetAtImpact("p2", aim, terrain);

    const state = createInitialState([shooter, target], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    const sender = vi.fn<(aim: ShotInput, def: ProjectileDef) => void>();
    mc.setFireSender(sender);

    const beforeTargetHp = target.hp;
    const beforeShooterHp = shooter.hp;
    const beforeDelay = state.players[0].accumulatedDelay;
    const beforeCharge = state.players[0].ssHitCharge;

    const result = mc.applyShot(aim, SHOT_1);

    // Fire-and-forget: forwards (aim, def) to the sender, returns undefined.
    expect(result).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(aim, SHOT_1);

    // It must NOT mutate any local state — HP/delay/SS-charge are server-authoritative now.
    expect(target.hp).toBe(beforeTargetHp);
    expect(shooter.hp).toBe(beforeShooterHp);
    expect(state.players[0].accumulatedDelay).toBe(beforeDelay);
    expect(state.players[0].ssHitCharge).toBe(beforeCharge);
  });

  it("Test A2: applyShot with no sender injected is a safe no-op (does not throw, no mutation)", () => {
    const terrain = freshTerrain();
    const shooter = firingMech("p1");
    const aim = landingAim(shooter, SHOT_1);
    const target = targetAtImpact("p2", aim, terrain);
    const state = createInitialState([shooter, target], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    expect(() => mc.applyShot(aim, SHOT_2)).not.toThrow();
    expect(target.hp).toBe(100);
  });

  it("Test C: advanceTurn picks the lowest accumulated delay (delay queue is still live for hotseat) (PLAY-06)", () => {
    const terrain = freshTerrain();
    const p1Mech = firingMech("p1");
    const p2Mech: Mech = { id: "p2", x: 900, y: 300, hp: 100 };
    const state = createInitialState([p1Mech, p2Mech], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    expect(state.activePlayerId).toBe("p1");

    // Hotseat drives the delay queue directly off state (applyShot no longer
    // accumulates delay). P1 has the lower accumulator → acts next.
    state.players[0].accumulatedDelay = 10;
    state.players[1].accumulatedDelay = 40;
    mc.advanceTurn();
    expect(state.activePlayerId).toBe("p1");

    // P1 acts again (still 20 < 40) before P2.
    state.players[0].accumulatedDelay = 20;
    mc.advanceTurn();
    expect(state.activePlayerId).toBe("p1");

    // Once P1 overtakes P2's accumulator, P2 acts next.
    state.players[0].accumulatedDelay = 50;
    mc.advanceTurn();
    expect(state.activePlayerId).toBe("p2");
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

  it("Test E: isSSArmed reads the live ssHitCharge against the arm threshold", () => {
    const terrain = freshTerrain();
    const a: Mech = { id: "p1", x: 100, y: 300, hp: 100 };
    const b: Mech = { id: "p2", x: 900, y: 300, hp: 100 };
    const state = createInitialState([a, b], [{ id: "p1" }, { id: "p2" }]);
    const mc = new MatchController(terrain, state);

    expect(mc.isSSArmed("p1")).toBe(false);
    state.players[0].ssHitCharge = 2;
    expect(mc.isSSArmed("p1")).toBe(false);
    state.players[0].ssHitCharge = 3;
    expect(mc.isSSArmed("p1")).toBe(true);
    // Firing the Trojan (server-side now) resets charge; isSSArmed reflects it.
    state.players[0].ssHitCharge = 0;
    expect(mc.isSSArmed("p1")).toBe(false);
  });

  it("Test F: previewTrajectory is non-empty and wind-reactive (PLAY-02, unchanged)", () => {
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

  it("rollWind stays within [WIN_MIN, WIN_MAX] with a seeded rng (unchanged)", () => {
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
