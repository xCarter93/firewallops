import { describe, it, expect } from "vitest";
import { convexDocToSyncedState } from "./convexDocToSyncedState.js";
import type { ConvexMatchDoc, SyncedMobile } from "./convexDocToSyncedState.js";

/**
 * Task 1 (plan 09-06) — the pure Convex-doc → scene SyncedState mapper.
 *
 * These tests pin the contract MatchScene.syncFromState relies on (MatchScene.ts:
 * 109-141): activeMobileId → activePlayer; mobiles[] → the {forEach,size} iterable
 * keyed by mobileId; sessionId sourced from mobileId; connected defaulting true.
 * The mapper MUST stay Phaser/scene-free (pure data transform), so this suite runs
 * headless with no Phaser import.
 */

/** A representative `api.match.get` return doc (accountId already stripped on read). */
function sampleDoc(): ConvexMatchDoc {
  return {
    phase: "AIMING",
    activeMobileId: "mob-A",
    wind: 0.42,
    turnEndsAt: 1_700_000_000,
    winnerTeam: -1,
    mobiles: [
      {
        mobileId: "mob-A",
        team: 0,
        x: 100,
        y: 200,
        hp: 100,
        angleDeg: 45,
        power: 0,
        facing: 1,
        ssHitCharge: 1,
        accumulatedDelay: 0,
        selectedItemId: "shot-1",
        connected: true,
      },
      {
        mobileId: "mob-B",
        team: 1,
        x: 900,
        y: 220,
        hp: 80,
        angleDeg: 135,
        power: 12,
        facing: -1,
        ssHitCharge: 0,
        accumulatedDelay: 300,
        selectedItemId: "shot-2",
        passive: true, // the training-range dummy — explicit passive flag
        // connected intentionally omitted → defaults true
      },
    ],
    localMobileId: "mob-A",
  };
}

describe("convexDocToSyncedState", () => {
  it("maps activeMobileId → activePlayer and passes scalars through", () => {
    const s = convexDocToSyncedState(sampleDoc());
    expect(s.activePlayer).toBe("mob-A");
    expect(s.phase).toBe("AIMING");
    expect(s.wind).toBe(0.42);
    expect(s.turnEndsAt).toBe(1_700_000_000);
    expect(s.winnerTeam).toBe(-1);
  });

  it("exposes mobiles as a {forEach,size} iterable keyed by mobileId", () => {
    const s = convexDocToSyncedState(sampleDoc());
    expect(s.mobiles.size).toBe(2);

    const seen: Record<string, string> = {};
    s.mobiles.forEach((mobile, key) => {
      seen[key] = mobile.sessionId;
    });
    expect(Object.keys(seen).sort()).toEqual(["mob-A", "mob-B"]);
    // key === mobileId, and sessionId is sourced from mobileId.
    expect(seen["mob-A"]).toBe("mob-A");
    expect(seen["mob-B"]).toBe("mob-B");
  });

  it("sources sessionId from mobileId and copies the mobile fields", () => {
    const s = convexDocToSyncedState(sampleDoc());
    let a: SyncedMobile | undefined;
    s.mobiles.forEach((m) => {
      if (m.sessionId === "mob-A") a = m;
    });
    expect(a).toBeDefined();
    expect(a!.team).toBe(0);
    expect(a!.x).toBe(100);
    expect(a!.y).toBe(200);
    expect(a!.hp).toBe(100);
    expect(a!.angleDeg).toBe(45);
    expect(a!.power).toBe(0);
    expect(a!.facing).toBe(1);
    expect(a!.ssHitCharge).toBe(1);
    expect(a!.accumulatedDelay).toBe(0);
    expect(a!.selectedItemId).toBe("shot-1");
  });

  it("defaults connected to true when the field is absent", () => {
    const s = convexDocToSyncedState(sampleDoc());
    const byId: Record<string, boolean> = {};
    s.mobiles.forEach((m) => {
      byId[m.sessionId] = m.connected;
    });
    expect(byId["mob-A"]).toBe(true); // explicitly true
    expect(byId["mob-B"]).toBe(true); // absent → defaults true
  });

  it("treats an explicit connected:false as disconnected", () => {
    const doc = sampleDoc();
    doc.mobiles[1].connected = false;
    const s = convexDocToSyncedState(doc);
    const byId: Record<string, boolean> = {};
    s.mobiles.forEach((m) => {
      byId[m.sessionId] = m.connected;
    });
    expect(byId["mob-B"]).toBe(false);
  });

  it("carries the training `passive` dummy flag through (explicit true; absent → false)", () => {
    // The training-detection rAF in play.ts reads the synced `passive` flag to
    // mount the TRAINING controls; the mapper must preserve it end-to-end.
    const s = convexDocToSyncedState(sampleDoc());
    const byId: Record<string, boolean> = {};
    s.mobiles.forEach((m) => {
      byId[m.sessionId] = m.passive;
    });
    expect(byId["mob-A"]).toBe(false); // no passive field on the doc → defaults false
    expect(byId["mob-B"]).toBe(true); // explicit passive:true → carried through
  });
});
