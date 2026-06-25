/**
 * Match-level durability mutations (scoped attribution — Phase 08 follow-up).
 *
 * Convex is PERSISTENCE ONLY: the authoritative MatchRoom owns the game; these
 * mutations are the durable seam it invokes (fire-and-forget) via
 * `ConvexHttpClient.mutation(api.matches.*)`. They mirror the `accounts.ts`
 * idempotency discipline (every access hits the `by_room_id` index — no
 * full-table scan, Convex 32k-scan safe).
 *
 *   - `recordStart` is idempotent on `room_id` (UPSERT): the first call inserts
 *     the active row with the roster; a repeat (e.g. a re-issue) refreshes the
 *     roster rather than duplicating the match.
 *   - `recordEnd` flips the row to a TERMINAL status; the FIRST terminal write
 *     wins (a row that is already `ended`/`abandoned` is a no-op), so an abandon
 *     that also ends the match does not get clobbered by a later normal-end write.
 *     If no start row exists (a write was lost), it inserts a terminal row so the
 *     match end is still recorded (with an empty roster — best-effort).
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";

const playerValidator = v.object({
  accountId: v.string(),
  team: v.number(),
  displayName: v.string(),
});

export const recordStart = mutation({
  args: {
    roomId: v.string(),
    mode: v.string(),
    players: v.array(playerValidator),
  },
  handler: async (ctx, { roomId, mode, players }) => {
    const existing = await ctx.db
      .query("matches")
      .withIndex("by_room_id", (q) => q.eq("room_id", roomId))
      .unique();
    if (existing) {
      // Refresh the roster (idempotent re-issue) — never insert a duplicate match.
      await ctx.db.patch(existing._id, { players });
      return existing._id;
    }
    return await ctx.db.insert("matches", {
      room_id: roomId,
      mode,
      status: "active",
      players,
    });
  },
});

export const recordEnd = mutation({
  args: {
    roomId: v.string(),
    status: v.union(v.literal("ended"), v.literal("abandoned")),
    winnerTeam: v.optional(v.number()),
  },
  handler: async (ctx, { roomId, status, winnerTeam }) => {
    const existing = await ctx.db
      .query("matches")
      .withIndex("by_room_id", (q) => q.eq("room_id", roomId))
      .unique();
    if (!existing) {
      // No start row landed (lost write / crash before start) — still record the
      // terminal event so the match end is not silently lost (empty roster).
      await ctx.db.insert("matches", {
        room_id: roomId,
        mode: "unknown",
        status,
        winner_team: winnerTeam,
        players: [],
      });
      return;
    }
    if (existing.status !== "active") return; // already terminal — first write wins.
    await ctx.db.patch(existing._id, { status, winner_team: winnerTeam });
  },
});
