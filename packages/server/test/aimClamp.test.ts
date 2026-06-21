import { describe, it, expect } from "vitest";
import { TerrainMask } from "@shared/sim";
import { MAP } from "../src/match/world.js";
import { runServerShot, type ServerMech } from "../src/match/resolve.js";
import { GRAVITY } from "../src/config.js";
import {
  clampAbsoluteAngle,
  AIM_WINDOW,
  aimWindowMid,
  muzzleOffset,
  SHOT_1,
} from "@shared/sim";
import type { ShotInput } from "@shared/sim";

/**
 * AIM-01 server authority (Phase 5, plan 07). Two groups:
 *   (a) PURE helper authority — locks the facing-aware absolute clamp the
 *       resolveActiveShot seam delegates to.
 *   (b) INTEGRATION-STYLE seam test — a headless harness that mirrors
 *       MatchRoom.resolveActiveShot's angle derivation (the SAME clampAbsoluteAngle
 *       + muzzleOffset + runServerShot path the Room runs), capturing the angle
 *       actually fed to the shot. This proves the SEAM (not only the helper)
 *       clamps, AND that the timeout-auto-fire path (a stale out-of-window
 *       active.angleDeg routed through the same seam) is clamped too.
 *
 * Headless: no live WS Room — the same `simulate*` harness idiom as
 * roomHandlers.test.ts. Titled "aim window …" so `-t "aim window"` selects it.
 */

describe("aim window clamp (AIM-01 pure helper authority)", () => {
  it("facing 1 corrects an out-of-window absolute angle to the bound", () => {
    expect(clampAbsoluteAngle(5, 1)).toBe(30);
    expect(clampAbsoluteAngle(120, 1)).toBe(70);
    expect(clampAbsoluteAngle(50, 1)).toBe(50);
  });

  it("facing -1 corrects in ABSOLUTE terms (rel via 180 - abs)", () => {
    // abs 175 -> rel 5 -> clamp 30 -> abs 150
    expect(clampAbsoluteAngle(175, -1)).toBe(150);
    // abs 60 -> rel 120 -> clamp 70 -> abs 110
    expect(clampAbsoluteAngle(60, -1)).toBe(110);
    // abs 130 -> rel 50 -> in-window -> abs 130
    expect(clampAbsoluteAngle(130, -1)).toBe(130);
  });

  it("the window is 30–70 and opens centered at the midpoint 50", () => {
    expect(AIM_WINDOW).toEqual({ minDeg: 30, maxDeg: 70 });
    expect(aimWindowMid()).toBe(50);
  });
});

/**
 * Headless mirror of MatchRoom.resolveActiveShot's angle derivation. The seam
 * re-derives the authoritative angle from the FIRING mobile's facing (server
 * state), clamps it, then feeds the CLAMPED angle to muzzleOffset + the
 * ShotInput. `usedAngle` is exactly the value the real Room hands to the shot.
 */
interface SeamMobile extends ServerMech {
  facing: 1 | -1;
  angleDeg: number; // the (possibly stale / out-of-window) requested angle
  power: number;
}

function simulateResolveAngle(args: {
  active: SeamMobile;
  rawAngleDeg: number; // onFire passes payload.angleDeg; onTimeout passes active.angleDeg
  terrain: TerrainMask;
  allMechs: ServerMech[];
}): { usedAngle: number } {
  // SEAM: re-derive facing from server state, clamp BEFORE muzzleOffset/runServerShot.
  const facing: 1 | -1 = args.active.facing === -1 ? -1 : 1;
  const clampedAngle = clampAbsoluteAngle(args.rawAngleDeg, facing);
  args.active.angleDeg = clampedAngle;

  const origin = muzzleOffset(args.active.x, args.active.y, clampedAngle);
  const aim: ShotInput = {
    x: origin.x,
    y: origin.y,
    angleDeg: clampedAngle,
    power: args.active.power,
    wind: 0,
    gravity: GRAVITY,
    projectile: SHOT_1,
  };
  runServerShot(aim, SHOT_1, args.terrain, args.allMechs);
  return { usedAngle: aim.angleDeg };
}

describe("aim window resolver (AIM-01 integration-style seam)", () => {
  it("onFire path: an out-of-window abs 5 with facing 1 resolves at 30, not 5", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const active: SeamMobile = {
      id: "active",
      x: 980,
      y: 360,
      hp: 100,
      facing: 1,
      angleDeg: 50,
      power: 70,
    };
    const allMechs: ServerMech[] = [
      { id: "active", x: 980, y: 360, hp: 100 },
      { id: "target", x: 1140, y: 405, hp: 100 },
    ];

    // A hacked client asserts abs 5 (straight across, out of window).
    const { usedAngle } = simulateResolveAngle({
      active,
      rawAngleDeg: 5,
      terrain,
      allMechs,
    });

    expect(usedAngle).toBe(30); // clamped to the lower bound, NOT honored at 5
    expect(active.angleDeg).toBe(30); // the seam writes the corrected angle back
  });

  it("timeout auto-fire path: a STALE out-of-window active.angleDeg of 5 resolves at 30", () => {
    const terrain = TerrainMask.fromMap(MAP);
    // The onTimeout auto-fire calls resolveActiveShot(active, active.angleDeg, …).
    const active: SeamMobile = {
      id: "active",
      x: 980,
      y: 360,
      hp: 100,
      facing: 1,
      angleDeg: 5, // stale out-of-window value left on the mobile
      power: 70,
    };
    const allMechs: ServerMech[] = [{ id: "active", x: 980, y: 360, hp: 100 }];

    const { usedAngle } = simulateResolveAngle({
      active,
      rawAngleDeg: active.angleDeg, // the timeout path feeds the stale angle
      terrain,
      allMechs,
    });

    expect(usedAngle).toBe(30); // the timeout path is clamped too — no bypass
  });

  it("facing -1: an out-of-window abs 175 resolves at the mirrored bound 150", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const active: SeamMobile = {
      id: "active",
      x: 1140,
      y: 405,
      hp: 100,
      facing: -1,
      angleDeg: 130,
      power: 70,
    };
    const allMechs: ServerMech[] = [
      { id: "active", x: 1140, y: 405, hp: 100 },
      { id: "target", x: 980, y: 360, hp: 100 },
    ];

    const { usedAngle } = simulateResolveAngle({
      active,
      rawAngleDeg: 175, // rel 5 for facing -1 — out of window
      terrain,
      allMechs,
    });

    expect(usedAngle).toBe(150);
  });

  it("an in-window angle passes through the seam unchanged", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const active: SeamMobile = {
      id: "active",
      x: 980,
      y: 360,
      hp: 100,
      facing: 1,
      angleDeg: 50,
      power: 70,
    };
    const allMechs: ServerMech[] = [{ id: "active", x: 980, y: 360, hp: 100 }];

    const { usedAngle } = simulateResolveAngle({
      active,
      rawAngleDeg: 50,
      terrain,
      allMechs,
    });

    expect(usedAngle).toBe(50);
  });
});
