import { describe, it, expect } from "vitest";
import { MatchState, Mobile } from "../src/rooms/schema/MatchState.js";

/**
 * NET-01 / NET-03 foundation: the schema IS the wire format clients mirror.
 * This is the first concrete coverage; Plan 03 extends with the live
 * WAITING→…→RESULTS transitions.
 */
describe("schema: MatchState / Mobile defaults", () => {
  it("constructs MatchState with the expected defaults and two mobiles", () => {
    const state = new MatchState();
    expect(state.phase).toBe("WAITING");
    expect(state.activePlayer).toBe("");
    expect(state.wind).toBe(0);
    expect(state.turnEndsAt).toBe(0);
    expect(state.winnerTeam).toBe(-1);

    state.mobiles.set("a", new Mobile());
    state.mobiles.set("b", new Mobile());
    expect(state.mobiles.size).toBe(2);

    const a = state.mobiles.get("a")!;
    expect(a.hp).toBe(100);
    expect(a.team).toBe(0);
    expect(a.powerLocked).toBe(false);
    expect(a.ssHitCharge).toBe(0);
    expect(a.facing).toBe(1);
    expect(a.angleDeg).toBe(45);
    expect(a.power).toBe(0);
    expect(a.selectedItemId).toBe("shot-1");
    expect(a.connected).toBe(true);
  });

  it("schema: deliberately excludes terrain/mask/bits fields (Pitfall 4)", () => {
    // `in`-operator form (NOT Object.keys, which may not reflect Colyseus
    // schema field enumeration — Codex/Cursor test-fragility note).
    const state = new MatchState();
    expect("terrain" in state).toBe(false);
    expect("mask" in state).toBe(false);
    expect("bits" in state).toBe(false);
  });

  it("schema: Mobile does NOT sync moveBudget (client-local cosmetic)", () => {
    expect("moveBudget" in new Mobile()).toBe(false);
  });
});
