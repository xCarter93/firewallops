import { describe, it, expect } from "vitest";
import {
  TerrainMask,
  SHOT_1,
  SHOT_2,
  muzzleOffset,
  expandFork,
  simulateTrajectory,
  resolveShot,
} from "@shared/sim";
import type { Mech, ShotInput, Carve, Damage } from "@shared/sim";
import { MAP } from "../src/match/world.js";
import { runServerShot, type ServerMech } from "../src/match/resolve.js";
import { GRAVITY } from "../src/config.js";
import { MatchController } from "../../client/src/match/MatchController.js";
import { createInitialState } from "../../client/src/match/MatchState.js";

/**
 * GOLDEN shot-parity test (NET-01).
 *
 * PHASE 3 NOTE: after Plan 04 the client no longer RESOLVES shots —
 * `MatchController.applyShot` is fire-and-forget and the server is the sole
 * authority. So the parity that survives (and matters) is twofold:
 *
 *   1. The client's COSMETIC aim preview (`previewTrajectory`, the only local
 *      sim call left on the client) must trace the SAME arc the server resolves
 *      and broadcasts — so what the player aims is what the server fires.
 *   2. The server authority (`runServerShot`) must reproduce the canonical
 *      `@shared/sim` composition (expandFork → simulateTrajectory primary →
 *      per-sub resolveShot with per-mech damage summing → clamped HP) exactly —
 *      no server-only drift in the wrapper.
 *
 * Both sides import the SAME hoisted loadout from `@shared/sim`, so a verbatim
 * server copy is impossible; these tests lock the resolution BODIES in lockstep.
 *
 * IF THIS FAILS: the client preview and the server authority have diverged —
 * the #1 NET-01 risk the reviewers flagged.
 */
describe("parity: client preview ↔ server authority (NET-01)", () => {
  const shooterX = 980;
  const shooterY = 360;
  const targetX = 1140;
  const targetY = 405;
  const mkMechs = () => [
    { id: "p1", x: shooterX, y: shooterY, hp: 100 },
    { id: "p2", x: targetX, y: targetY, hp: 100 },
  ];

  it("the client aim preview arc matches the server authoritative arc (SHOT_1)", () => {
    const origin = muzzleOffset(shooterX, shooterY, 58);
    const aim: ShotInput = {
      x: origin.x,
      y: origin.y,
      angleDeg: 58,
      power: 70,
      wind: -15,
      gravity: GRAVITY,
      projectile: SHOT_1,
    };

    // Client cosmetic preview (the surviving local-sim call).
    const previewTerrain = TerrainMask.fromMap(MAP);
    const state = createInitialState(mkMechs(), [{ id: "p1" }, { id: "p2" }]);
    const controller = new MatchController(previewTerrain, state);
    const previewPath = controller.previewTrajectory(aim);

    // Server authoritative primary arc.
    const serverTerrain = TerrainMask.fromMap(MAP);
    const serverResult = runServerShot(aim, SHOT_1, serverTerrain, mkMechs());

    expect(serverResult.path).toEqual(previewPath);
  });

  it("runServerShot deep-equals a direct @shared/sim resolution for SHOT_2 fork", () => {
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

    // --- Reference: the canonical @shared/sim composition, computed
    // independently of any server-wrapper code, on its own mask/mechs. ---
    const refTerrain = TerrainMask.fromMap(MAP);
    const refMechs: Mech[] = mkMechs();
    const subShots = expandFork(aim, SHOT_2);
    const refPrimary = simulateTrajectory(subShots[0], refTerrain);
    const refCarves: Carve[] = [];
    const refTotals = new Map<string, number>();
    for (const sub of subShots) {
      const { carves, damage } = resolveShot(
        sub,
        refTerrain,
        refMechs,
        sub.projectile,
      );
      refCarves.push(...carves);
      for (const d of damage) {
        refTotals.set(d.mechId, (refTotals.get(d.mechId) ?? 0) + d.amount);
      }
    }
    const refDamage: Damage[] = [...refTotals].map(([mechId, amount]) => ({
      mechId,
      amount,
    }));
    for (const d of refDamage) {
      const m = refMechs.find((x) => x.id === d.mechId);
      if (m) m.hp = Math.max(0, m.hp - d.amount);
    }

    // --- Server authority on an INDEPENDENT mask/mechs from the same MAP. ---
    const srvTerrain = TerrainMask.fromMap(MAP);
    const srvMechs: ServerMech[] = mkMechs();
    const serverResult = runServerShot(aim, SHOT_2, srvTerrain, srvMechs);

    // Byte-identical outcome.
    expect(serverResult.carves).toEqual(refCarves);
    expect(serverResult.damage).toEqual(refDamage);
    expect(serverResult.path).toEqual(refPrimary.path);
    expect(serverResult.impact).toEqual(refPrimary.impact);

    // The masks carved identically.
    expect(Array.from(srvTerrain.bits)).toEqual(Array.from(refTerrain.bits));

    // Resulting mech HP matches the reference.
    for (const m of srvMechs) {
      const ref = refMechs.find((c) => c.id === m.id);
      expect(ref).toBeDefined();
      expect(m.hp).toBe(ref!.hp);
    }
  });
});
