import { describe, it, expect } from "vitest";
import { TerrainMask, SHOT_2, muzzleOffset } from "@shared/sim";
import type { Mech, ShotInput } from "@shared/sim";
import { MAP } from "../src/match/world.js";
import { runServerShot, type ServerMech } from "../src/match/resolve.js";
import { GRAVITY } from "../src/config.js";
import { MatchController } from "../../client/src/match/MatchController.js";
import { createInitialState } from "../../client/src/match/MatchState.js";

/**
 * GOLDEN client↔server shot-parity test (NET-01, Agreed Concern #1).
 *
 * Proves `runServerShot` (server authority) deep-equals the client
 * `MatchController.applyShot` for IDENTICAL inputs. Both sides import the SAME
 * hoisted `expandFork` + SHOT_2 def from `@shared/sim`, so the only thing under
 * test is that the two resolution BODIES stay in lockstep.
 *
 * The cross-package import of the client MatchController is clean: MatchController
 * lives in the headless `src/match/**` seam (ESLint-gated phaser-free), so it
 * pulls in no Phaser/DOM — Vitest resolves it via the workspace under the
 * bare-Node test environment.
 *
 * IF THIS FAILS: the client preview and the server authority have diverged —
 * the #1 NET-01 risk the reviewers flagged. The hoisted @shared/sim loadout +
 * this test together make divergence impossible to ship silently.
 */
describe("parity: shot parity (client applyShot deep-equals runServerShot)", () => {
  it("carves, damage, path, and resulting HP match byte-for-byte for SHOT_2", () => {
    // Two INDEPENDENT masks so the in-place carves on each side don't
    // cross-contaminate, but built from the SAME deterministic MAP.
    const terrainA = TerrainMask.fromMap(MAP); // client side
    const terrainB = TerrainMask.fromMap(MAP); // server side

    // Identical mech layouts (same ids/x/y/hp). The shot is a 3-way fork aimed
    // to crater the ground near both mobiles.
    const shooterX = 980;
    const shooterY = 360;
    const targetX = 1140;
    const targetY = 405;

    const mechsClient: Mech[] = [
      { id: "p1", x: shooterX, y: shooterY, hp: 100 },
      { id: "p2", x: targetX, y: targetY, hp: 100 },
    ];
    const mechsServer: ServerMech[] = [
      { id: "p1", x: shooterX, y: shooterY, hp: 100 },
      { id: "p2", x: targetX, y: targetY, hp: 100 },
    ];

    // One fixed aim, built from the SHARED muzzle-tip origin (Authority
    // Decision 4) so both sides launch from the identical barrel tip.
    const origin = muzzleOffset(shooterX, shooterY, 62);
    const aim: ShotInput = {
      x: origin.x,
      y: origin.y,
      angleDeg: 62,
      power: 72,
      wind: 25,
      gravity: GRAVITY,
      projectile: SHOT_2,
    };

    // --- Client side ---
    const state = createInitialState(mechsClient, [{ id: "p1" }, { id: "p2" }]);
    const controller = new MatchController(terrainA, state);
    const clientResult = controller.applyShot(aim, SHOT_2);

    // --- Server side ---
    const serverResult = runServerShot(aim, SHOT_2, terrainB, mechsServer);

    // Byte-identical outcome.
    expect(serverResult.carves).toEqual(clientResult.carves);
    expect(serverResult.damage).toEqual(clientResult.damage);
    expect(serverResult.path).toEqual(clientResult.path);
    expect(serverResult.impact).toEqual(clientResult.impact);

    // The masks carved identically.
    expect(Array.from(terrainA.bits)).toEqual(Array.from(terrainB.bits));

    // Resulting mech HP matches on both sides.
    for (const m of mechsServer) {
      const clientMech = state.mechs.find((c) => c.id === m.id);
      expect(clientMech).toBeDefined();
      expect(m.hp).toBe(clientMech!.hp);
    }
  });
});
