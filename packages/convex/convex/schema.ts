import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Phase-4 persistence skeleton (DEPLOY-04, Convex half).
 *
 * Auth-agnostic by design: `auth_user_id` is the external subject id (the auth
 * provider's `sub` in Phase 5). NOTHING auth-specific (no provider fields, no
 * email/token) is baked in now so Phase-5 auth wiring lands without a migration fight.
 *
 * Skeleton only — NO mutations / write logic this phase (CONTEXT "Database / persistence").
 * `_id` + `_creationTime` are auto-added by Convex; do not declare them.
 */
export default defineSchema({
  accounts: defineTable({
    auth_user_id: v.string(),
    display_name: v.optional(v.string()),
    wins: v.optional(v.number()),
    losses: v.optional(v.number()),
  }).index("by_auth_user_id", ["auth_user_id"]),

  /**
   * Granular per-player+event idempotency ledger (Phase-5 Blocker 2).
   *
   * Additive table (the `accounts` table above is byte-identical / unchanged).
   * A `result_id` is the per-player+event key `${roomId}:${event}:${accountId}`
   * (event ∈ {final, abandon}), so a final-match write and an abandon write for
   * the SAME room+player carry DISTINCT ids and never collide — replacing the old
   * single `resultId: roomId` scheme that collapsed both into one. `recordResult`
   * records an applied id here; a repeated id is a no-op.
   */
  result_events: defineTable({
    result_id: v.string(),
  }).index("by_result_id", ["result_id"]),

  /**
   * Match-level durability ledger (scoped attribution — Phase 08 follow-up).
   *
   * One row per match, keyed by the Colyseus `room_id`. Captures WHO was in the
   * match (the player→account→team binding) at START and the terminal status at
   * END, so a match that never reaches a clean end (server crash/redeploy
   * mid-match) still leaves a durable, attributable record — independent of the
   * per-player W/L counters in `accounts` (which are written separately).
   *
   * WRITE-ONLY for now: nothing reads this back, so there is no live-room
   * rehydration and no client divergence risk. `_creationTime` is the auto
   * created-at. Writes are idempotent on `room_id` (upsert): `recordStart` inserts
   * or refreshes the roster; `recordEnd` flips status terminally (first terminal
   * write wins). Every access hits the `by_room_id` index (no full-table scan).
   */
  matches: defineTable({
    room_id: v.string(),
    mode: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("ended"),
      v.literal("abandoned"),
    ),
    winner_team: v.optional(v.number()),
    players: v.array(
      v.object({
        accountId: v.string(),
        team: v.number(),
        displayName: v.string(),
      }),
    ),
  }).index("by_room_id", ["room_id"]),
});
