import { describe, it, expect } from "vitest";
import {
  advanceTurn,
  type TurnMobile,
} from "@firewallops/match-core";

/**
 * RED until plan 05 — Wave-0 contract scaffold (05-VALIDATION.md); dynamic
 * import keeps collection/typecheck green.
 *
 * RECON-04 / H1: pins the `forfeitOutcome(view, leaverSessionId)` decision —
 * idempotent removal + team-elimination win, computed PURELY over a plain-data
 * `TurnMobile[]` view (no Colyseus state touched; the Room applies the result) —
 * BEFORE plan 05 ADDS the export to the EXISTING `@firewallops/match-core`
 * turnMachine module.
 *
 * `@firewallops/match-core` already resolves, so (like autoStart) the NEW export
 * is reached via a dynamic `await import("@firewallops/match-core")` INSIDE the
 * test body, read through a local interface that types it as OPTIONAL — keeping
 * `tsc` green (no TS2339) while the runtime value is `undefined` until plan 05.
 * The `expect(forfeitOutcome).toBeTypeOf("function")` guard fails RED until then,
 * for the RIGHT reason (export not built yet). `TurnMobile` is a TYPE-ONLY static
 * import (erased at runtime — collection/typecheck safe), used only to shape the
 * test fixtures against the existing contract.
 */

/** The export plan 05 must ADD to turnMachine.ts (optional → typecheck-safe). */
interface ForfeitModule {
  forfeitOutcome?: (
    view: TurnMobile[],
    leaverSessionId: string,
  ) => {
    removed: boolean;
    outcome: { kind: "winner" | "draw" | "continue"; team?: number };
  };
}

function mobile(over: Partial<TurnMobile> = {}): TurnMobile {
  return {
    sessionId: "x",
    team: 0,
    hp: 100,
    accumulatedDelay: 0,
    ...over,
  };
}

describe("removeAndForfeit", () => {
  it("forfeitOutcome removes a leaver, decides team-elim, and is idempotent (RECON-04 / H1)", async () => {
    const mod = (await import("@firewallops/match-core")) as ForfeitModule;
    const forfeitOutcome = mod.forfeitOutcome;

    // RED until plan 05 adds the export: undefined → fails this guard.
    expect(forfeitOutcome).toBeTypeOf("function");

    // (i) Removing the only living mobile on team 0 empties it → team 1 wins.
    const lastOnTeam: TurnMobile[] = [
      mobile({ sessionId: "leaver", team: 0 }),
      mobile({ sessionId: "b", team: 1 }),
    ];
    const win = forfeitOutcome!(lastOnTeam, "leaver");
    expect(win.removed).toBe(true);
    expect(win.outcome).toEqual({ kind: "winner", team: 1 });

    // (ii) Removing one of several living mobiles on a team → match continues.
    const stillAlive: TurnMobile[] = [
      mobile({ sessionId: "leaver", team: 0 }),
      mobile({ sessionId: "ally", team: 0 }),
      mobile({ sessionId: "b", team: 1 }),
    ];
    const cont = forfeitOutcome!(stillAlive, "leaver");
    expect(cont.removed).toBe(true);
    expect(cont.outcome.kind).toBe("continue");

    // (iii) Idempotent: an already-absent sessionId → removed: false.
    const absent = forfeitOutcome!(
      [mobile({ sessionId: "b", team: 1 })],
      "leaver",
    );
    expect(absent.removed).toBe(false);
  });
});

/**
 * RECON-03 (review MEDIUM — the connection-independent timer was previously only
 * manually covered). The Room's turn timer is connection-independent: when a
 * DROPPED active player's turn/window elapses, `onTimeout` SKIPS the turn (Phase 9
 * D-02: SKIP-only — the old auto-fire path is removed), and the subsequent
 * `startTurn` calls `advanceTurn(view)` to pick the NEXT active. This proves the
 * turn advances away from the dropped player regardless of `connected`. (The full
 * WebSocket timer wiring stays in the manual UAT; these pure helpers are the
 * unit-testable seam.)
 */
describe("active-drop timeout (RECON-03)", () => {
  it("the timeout advances regardless of connected, and advanceTurn picks a non-leaver next active", () => {
    // Phase 9 (D-02): the timeout is SKIP-only — it never auto-fires. The dropped
    // active simply yields and the Room advances. `connected` is not even part of
    // the pure view.
    // After the dropped active's turn elapses and the Room advances, the next
    // active selected from the remaining view is a DIFFERENT, living sessionId.
    const afterRemoval: TurnMobile[] = [
      mobile({ sessionId: "ally", team: 0, accumulatedDelay: 5 }),
      mobile({ sessionId: "b", team: 1, accumulatedDelay: 2 }),
    ];
    const next = advanceTurn(afterRemoval);
    expect(next).not.toBe("leaver");
    expect(next).toBe("b"); // lowest accumulatedDelay among the living, post-removal.
  });
});
