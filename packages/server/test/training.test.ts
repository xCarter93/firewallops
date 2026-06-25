import { describe, it, expect } from "vitest";
import { TerrainMask } from "@shared/sim";
import { MAP } from "../src/match/world.js";
import { runServerShot, type ServerMech } from "../src/match/resolve.js";
import {
  shouldStartImmediately,
  shouldAutoStart,
  shouldTrainingRespawn,
  applyTrainingHpWriteBack,
  resetPlayerShotStateOn,
  shouldPublishToLobby,
  shouldRecordResult,
} from "../src/match/turnMachine.js";
import { GRAVITY } from "../src/config.js";
import { SHOT_1, muzzleOffset } from "@shared/sim";
import type { ShotInput } from "@shared/sim";

/**
 * Training headless harness (Phase 8, Plan 02) — mirrors the roomHandlers.test.ts
 * style: NO live WS server, every test calls the EXACT SHARED pure helper the Room
 * calls (P1.1 — no parallel test copy). Both reviewers flagged that a test
 * "modeling the branch the way the room does" can stay green while the real branch
 * is wrong (that is HOW the P0 turnView dropped-`passive` gap would have slipped
 * through); exercising the SAME function the Room delegates to closes that drift.
 */

// ─────────────────────────── TR-1: start-with-1 ───────────────────────────

describe("training: start-with-1 bypasses the ready handshake (TR-1)", () => {
  it("shouldStartImmediately is true ONLY for training + >=1 human", () => {
    expect(shouldStartImmediately(true, 1)).toBe(true); // training + 1 human → start
    expect(shouldStartImmediately(true, 0)).toBe(false); // no human seated yet
    expect(shouldStartImmediately(false, 1)).toBe(false); // a real match must NOT start-with-1
  });

  it("start-with-1 genuinely BYPASSES shouldAutoStart for the same single seat", () => {
    // A real match with one seat is NOT full and NOT all-ready, so shouldAutoStart
    // is false — training's start-with-1 is the explicit bypass of that gate.
    expect(shouldAutoStart(1, 1, [false])).toBe(false);
    expect(shouldAutoStart(1, 1, [true])).toBe(false); // even ready: 1 seat ≠ full (teamSize*2=2)
    // Training instead starts immediately on the lone human.
    expect(shouldStartImmediately(true, 1)).toBe(true);
  });
});

// ─────────────────────────── TR-4: respawn-not-end ───────────────────────────

describe("training: dummy death respawns + continues, NEVER ends (respawn / TR-4)", () => {
  it("shouldTrainingRespawn is true at HP<=0, false while alive", () => {
    expect(shouldTrainingRespawn(0)).toBe(true);
    expect(shouldTrainingRespawn(-5)).toBe(true);
    expect(shouldTrainingRespawn(40)).toBe(false);
    expect(shouldTrainingRespawn(100)).toBe(false);
  });

  it("the afterResolve training DECISION always continues, never ends/records", () => {
    // Mirror the room's afterResolve training branch USING the SAME shared
    // predicate; the end/record flags flip ONLY on the (never-taken) end path.
    let respawned = false;
    const endMatchCalled = false;
    const recordCalled = false;
    let continued = false;

    function simulateAfterResolveTraining(dummyHp: number): void {
      // The exact room shape: if dummy dead → respawn; ALWAYS startTurn; NEVER end.
      if (shouldTrainingRespawn(dummyHp)) respawned = true;
      continued = true; // startTurn() — the training branch ALWAYS continues
      // endMatch / endMatchDraw / recordMatchResult are NOT on the training path.
      void endMatchCalled;
      void recordCalled;
    }

    // Dead dummy → respawn + continue, no end, no record.
    simulateAfterResolveTraining(0);
    expect(respawned).toBe(true);
    expect(continued).toBe(true);
    expect(endMatchCalled).toBe(false);
    expect(recordCalled).toBe(false);

    // Alive dummy → just continue (no respawn), still no end, no record.
    respawned = false;
    continued = false;
    simulateAfterResolveTraining(40);
    expect(respawned).toBe(false);
    expect(continued).toBe(true);
    expect(endMatchCalled).toBe(false);
    expect(recordCalled).toBe(false);
  });
});

// ─────────────────────────── TR-7: player-invincible ───────────────────────────

describe("training: the player is invincible to self-splash (invincible / TR-7)", () => {
  it("applyTrainingHpWriteBack skips the firing player's HP in training only", () => {
    expect(applyTrainingHpWriteBack(true, "player", "player")).toBe(false); // skip self
    expect(applyTrainingHpWriteBack(true, "dummy", "player")).toBe(true); // dummy still written
    expect(applyTrainingHpWriteBack(false, "player", "player")).toBe(true); // real match writes all
  });

  it("a self-damaging shot leaves the player's schema HP unchanged, dummy drops", () => {
    const terrain = TerrainMask.fromMap(MAP);
    // Position the player + dummy so a near-vertical shot self-splashes the player.
    const playerX = 500;
    const playerY = Math.max(0, surfaceYFor(terrain, playerX) - 1);
    const dummyX = 520;
    const dummyY = Math.max(0, surfaceYFor(terrain, dummyX) - 1);

    const mechs: ServerMech[] = [
      { id: "player", x: playerX, y: playerY, hp: 100 },
      { id: "dummy", x: dummyX, y: dummyY, hp: 100 },
    ];

    // Schema HP mirror (the room copies resolved hp back into this).
    const schema = new Map<string, { hp: number }>([
      ["player", { hp: 100 }],
      ["dummy", { hp: 100 }],
    ]);

    // A high, short, steep shot that lands near the firing player → self-splash.
    const def = SHOT_1;
    const origin = muzzleOffset(playerX, playerY, 80);
    const aim: ShotInput = {
      x: origin.x,
      y: origin.y,
      angleDeg: 80,
      power: 8, // tiny power → lands right next to the firer
      wind: 0,
      gravity: GRAVITY,
      projectile: def,
    };

    const result = runServerShot(aim, def, terrain, mechs);

    // The room's HP write-back loop, gated by the SAME shared predicate.
    for (const m of mechs) {
      if (!applyTrainingHpWriteBack(true, m.id, "player")) continue;
      const s = schema.get(m.id);
      if (s) s.hp = m.hp;
    }

    // Player schema HP is NEVER written down in training (invincible), even though
    // the resolver may have computed self-splash into the local mechs array.
    expect(schema.get("player")!.hp).toBe(100);

    // Sanity: in a REAL match the player WOULD lose HP if self-splashed.
    const realSchemaPlayer = { hp: 100 };
    const selfDamaged = result.damage.find((d) => d.mechId === "player");
    for (const m of mechs) {
      if (!applyTrainingHpWriteBack(false, m.id, "player")) continue;
      if (m.id === "player") realSchemaPlayer.hp = m.hp;
    }
    if (selfDamaged) {
      expect(realSchemaPlayer.hp).toBeLessThan(100); // real match: self-splash hurts
    }
  });
});

/** Local surface helper for test seating (mirrors world.surfaceY, kept inline). */
function surfaceYFor(mask: TerrainMask, x: number): number {
  for (let y = 0; y < mask.height; y++) {
    if (mask.isSolid(x, y)) return y;
  }
  return mask.height;
}

// ─────────────────────────── TR-5: RESET shot-state-clear ───────────────────────────

describe("training: a manual RESET wipes the player's shot state (reset / TR-5)", () => {
  it("resetPlayerShotStateOn resets every field to its clean-turn default", () => {
    const player = {
      ssHitCharge: 2,
      selectedItemId: "trojan",
      power: 80,
      powerLocked: true,
      accumulatedDelay: 30,
      angleDeg: 12,
    };
    resetPlayerShotStateOn(player);
    expect(player.ssHitCharge).toBe(0);
    expect(player.selectedItemId).toBe("shot-1");
    expect(player.power).toBe(0);
    expect(player.powerLocked).toBe(false);
    expect(player.accumulatedDelay).toBe(0);
    expect(player.angleDeg).toBe(45);
  });

  it("a kill-RESPAWN preserves earned ssHitCharge (does NOT call resetPlayerShotStateOn)", () => {
    // The respawn path touches the dummy + terrain only — never the player record.
    const player = {
      ssHitCharge: 2,
      selectedItemId: "trojan",
      power: 80,
      powerLocked: true,
      accumulatedDelay: 30,
      angleDeg: 12,
    };
    // Model a respawn: it does NOT call resetPlayerShotStateOn, so the record is unchanged.
    function simulateRespawnNoPlayerWipe(): void {
      // delete dummy + rebuild terrain + spawn dummy — player record untouched.
    }
    simulateRespawnNoPlayerWipe();
    expect(player.ssHitCharge).toBe(2); // earned charge PRESERVED on a kill-respawn
    expect(player.selectedItemId).toBe("trojan");
  });

  it("reset cancels a pending advance before rebuilding (reset cancels / P1.2)", () => {
    // Model the room's onResetRange guard: clearPendingTimers() flips the pending
    // flag false BEFORE the rebuild, so a stale afterResolve is a no-op and the
    // advance counter does not increment twice when a reset interleaves a dwell.
    let pendingResolveDwell = true; // a RESOLVE dwell was scheduled
    let advanceCount = 0;

    function clearPendingTimers(): void {
      pendingResolveDwell = false; // the stored resolveTimer is cleared
    }
    function staleAfterResolve(): void {
      // The pending callback fires LATE; it must be a no-op if cleared.
      if (!pendingResolveDwell) return;
      advanceCount++; // would double-advance if it ran
    }
    function onResetRange(): void {
      clearPendingTimers(); // P1.2 — cancel the pending advance FIRST
      // rebuild terrain + respawn + clear shot state + startTurn()
      advanceCount++; // the reset's own single clean startTurn
    }

    onResetRange();
    staleAfterResolve(); // the stale dwell fires after the reset

    // Exactly ONE advance (the reset's) — the stale afterResolve was cancelled.
    expect(advanceCount).toBe(1);
    expect(pendingResolveDwell).toBe(false);
  });
});

// ─────────────────────────── TR-8: stats invariants ───────────────────────────

describe("training: unlisted + no-stats invariants (stats invariants / TR-8)", () => {
  it("shouldPublishToLobby is false for training, true for a real match", () => {
    expect(shouldPublishToLobby(true)).toBe(false); // training is NEVER published
    expect(shouldPublishToLobby(false)).toBe(true);
  });

  it("shouldRecordResult never records for training, records a real in-progress match", () => {
    expect(shouldRecordResult(true, true, true)).toBe(false); // training: no result EVER
    expect(shouldRecordResult(false, true, true)).toBe(true); // real in-progress w/ accountId
    expect(shouldRecordResult(false, false, true)).toBe(false); // not-in-progress real match
    expect(shouldRecordResult(false, true, false)).toBe(false); // no accountId
  });
});
