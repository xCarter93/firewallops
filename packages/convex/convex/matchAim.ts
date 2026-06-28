/**
 * OPPONENT-AIM TELEGRAPH — the throttled live-aim surface (Phase 9, Plan 10).
 *
 * This is the affordable, DROPPABLE replacement for the deleted Colyseus aim
 * stream (`MatchRoom.onAim`, 724-746). It restores the founder's "watch them aim"
 * feel (D-01) WITHOUT per-frame writes to the turn-serialized `matches` doc:
 *
 *   - the active player's barrel angle is written to a SEPARATE single-row
 *     `matchAim` doc (one row per match, `by_match`), NOT the reactive `matches`
 *     doc (R4 / 09-RESEARCH Anti-Patterns — never write aim to the match doc), and
 *   - the write is DELTA-GATED: it only fires when the coarse-quantized (whole
 *     degree) angle differs from the last written value, so a held/idle aim costs
 *     nothing, and the client throttles emission to ≤5 Hz on top of this.
 *
 * AUTHORITY INVARIANTS (mirrors `match.ts`):
 *   - auth: `getUserIdentity()` is required (D-10); a null identity is rejected.
 *   - membership + active-player: the caller's `mobileId` is resolved SERVER-SIDE
 *     off `mobiles[]` by matching the verified subject (never a client-sent id —
 *     D-08), then gated through `canFire(phase, mobileId, activeMobileId)` — the
 *     SAME active-player+AIMING predicate `MatchRoom.onAim` used. A non-active /
 *     non-member / unauthenticated caller writes nothing.
 *   - clamp: the stored angle is `clampAbsoluteAngle(angleDeg, facing)` — the SAME
 *     authoritative clamp `fireShot` and `onAim` apply (facing is server state).
 *
 * COSMETIC-ONLY (D-02 / T-09-22): live-aim NEVER gates fire. `fireShot` reads its
 * OWN payload and ignores `matchAim` entirely — there is no authority surface to
 * attack here. Cutting this whole file leaves the authority loop untouched.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { canFire } from "@firewallops/match-core";
import { clampAbsoluteAngle } from "@shared/sim";

/** Reject + return the verified Clerk subject (D-10) — mirrors `match.ts`. */
async function requireIdentity(ctx: {
  auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
}): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");
  return identity.subject;
}

/**
 * Stream the ACTIVE player's barrel aim to the opponent (NET — cosmetic). Ports
 * `MatchRoom.onAim`'s active-player gate + clamp onto a SEPARATE throttled doc.
 *
 * - auth + membership + active-player gate (`canFire` — AIMING && caller is the
 *   active mobile). A caller that is not the active player is a SILENT no-op (no
 *   throw — mirrors `onAim`'s early returns and `fireShot`'s out-of-turn no-op),
 *   so a stray emission while it is not your turn simply does nothing.
 * - the caller `mobileId` is resolved SERVER-SIDE (never trusted from args).
 * - `clampAbsoluteAngle(angleDeg, facing)` (facing from server state), then
 *   coarse-quantize to whole degrees.
 * - DELTA-GATE: upsert the single `by_match` row ONLY when the quantized angle
 *   differs from the last written value; bump `seq`. NEVER patches the `matches`
 *   doc (R4).
 */
export const updateAim = mutation({
  args: {
    matchId: v.id("matches"),
    angleDeg: v.number(),
  },
  handler: async (ctx, { matchId, angleDeg }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) return; // match gone — nothing to telegraph.

    // Resolve the caller's mobile SERVER-SIDE off mobiles[] (never trust a
    // client-sent id — D-08). A non-member cannot aim.
    const mobile = match.mobiles.find((m) => m.accountId === accountId);
    if (!mobile) return; // not a member — silent no-op (cosmetic).

    // Active-player + phase gate (the SAME predicate onAim/selectItem read).
    // Out-of-turn / wrong-phase aim → silent no-op (never a throw).
    if (!canFire(match.phase, mobile.mobileId, match.activeMobileId)) return;

    // AIM-01 authoritative clamp from the firing mobile's SERVER facing (never
    // client input) — identical to fireShot's clamp seam — then coarse-quantize
    // to whole degrees (the delta-gate granularity; ≤1° moves never write).
    const facing: 1 | -1 = mobile.facing === -1 ? -1 : 1;
    const quantized = Math.round(clampAbsoluteAngle(angleDeg, facing));

    // The single live-aim row for this match (one per match, by_match index).
    const existing = await ctx.db
      .query("matchAim")
      .withIndex("by_match", (q) => q.eq("matchId", matchId))
      .unique();

    // DELTA-GATE: skip the write when the quantized angle (for THIS mobile) is
    // unchanged — a held/idle aim costs zero writes (T-09-20 mitigation).
    if (
      existing &&
      existing.mobileId === mobile.mobileId &&
      existing.angleDeg === quantized
    ) {
      return;
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        mobileId: mobile.mobileId,
        angleDeg: quantized,
        seq: existing.seq + 1,
      });
    } else {
      await ctx.db.insert("matchAim", {
        matchId,
        mobileId: mobile.mobileId,
        angleDeg: quantized,
        seq: 1,
      });
    }
  },
});

/**
 * Read the current live-aim telegraph for a match — `{ mobileId, angleDeg, seq }`
 * or `null` when no aim has been written yet. The opponent's client subscribes to
 * this (`client.onUpdate`) and feeds the angle into its barrel render. Auth is
 * required (no leak); the value is cosmetic-only.
 */
export const get = query({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    await requireIdentity(ctx);
    const row = await ctx.db
      .query("matchAim")
      .withIndex("by_match", (q) => q.eq("matchId", matchId))
      .unique();
    if (!row) return null;
    return { mobileId: row.mobileId, angleDeg: row.angleDeg, seq: row.seq };
  },
});
