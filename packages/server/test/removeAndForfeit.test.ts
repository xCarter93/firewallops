import { describe, it, expect } from "vitest";
import type { TurnMobile } from "../src/match/turnMachine.js";

/**
 * RED until plan 05 — Wave-0 contract scaffold (05-VALIDATION.md); dynamic
 * import keeps collection/typecheck green.
 *
 * RECON-04 / H1: pins the `forfeitOutcome(view, leaverSessionId)` decision —
 * idempotent removal + team-elimination win, computed PURELY over a plain-data
 * `TurnMobile[]` view (no Colyseus state touched; the Room applies the result) —
 * BEFORE plan 05 ADDS the export to the EXISTING `src/match/turnMachine.js`.
 *
 * `turnMachine.js` already resolves, so (like autoStart) the NEW export is
 * reached via a dynamic `await import("../src/match/turnMachine.js")` INSIDE the
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
    powerLocked: false,
    ...over,
  };
}

describe("removeAndForfeit", () => {
  it("forfeitOutcome removes a leaver, decides team-elim, and is idempotent (RECON-04 / H1)", async () => {
    const mod = (await import("../src/match/turnMachine.js")) as ForfeitModule;
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
