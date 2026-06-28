/**
 * Scheduled / internal authority mutations (Phase 9).
 *
 * ───────────────────────────── PLAN-04 STUB ─────────────────────────────
 * THIS FILE CURRENTLY CONTAINS ONLY A MINIMAL `startTurn` STUB (review [C]).
 *
 * Plan 04 (this plan) needs `internal.match_internal.startTurn` to be a REAL
 * codegen symbol so `toggleReady`'s auto-start path can call it WITHOUT a
 * forward reference that would false-pass the generated API (or a test that
 * never resolves a real function). The stub does the minimal real work the
 * auto-start test observes: it flips the match phase OUT of `WAITING`
 * (→ `TURN_START`) and bumps `turnSeq`. That is ALL it asserts — NOT the
 * plan-05 turn mechanics (advanceTurn / rollWind / enterAiming dwell /
 * onTurnTimeout scheduler / activeMobileId selection).
 *
 * PLAN 05 REPLACES THE BODY of `startTurn` below with the full turn-start
 * logic (advanceTurn(turnView) → activeMobileId, rollWind, reset active aim,
 * schedule enterAiming via ctx.scheduler) and adds the rest of the scheduled
 * internals (enterAiming / onTurnTimeout / afterResolve / endMatch). It edits
 * THIS file in place — the export name + signature stay stable so no callsite
 * (toggleReady, the auto-start test) needs to change.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * [C] Minimal REAL `startTurn` stub. Plan 04 only requires that the match
 * leaves `WAITING`; plan 05 fills in advanceTurn / rollWind / scheduler.
 *
 * Idempotent-ish: if the match has already started (phase past WAITING) it
 * still bumps `turnSeq` harmlessly, but the auto-start path only invokes it
 * once at the WAITING→TURN_START transition.
 */
export const startTurn = internalMutation({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const match = await ctx.db.get(matchId);
    if (!match) return;
    // Leave WAITING so the auto-start test observes the transition against a
    // REAL symbol. Plan 05 replaces this with the full turn-start sequence.
    await ctx.db.patch(matchId, {
      status: "active",
      phase: "TURN_START",
      turnSeq: match.turnSeq + 1,
    });
  },
});
