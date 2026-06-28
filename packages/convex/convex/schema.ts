import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Phase-4 persistence skeleton (DEPLOY-04, Convex half), extended in Phase 9
 * with the LIVE authoritative match model (the pure-Convex backend migration).
 *
 * Auth-agnostic by design: `auth_user_id` is the external subject id (the auth
 * provider's `sub`). NOTHING auth-specific (no provider fields, no email/token)
 * is baked in, so the Phase-9 native Convex+Clerk auth wiring lands without a
 * migration fight — `accountId` everywhere is `ctx.auth.getUserIdentity().subject`.
 *
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
   * LIVE authoritative match state — the reactive doc clients subscribe to
   * (Phase 9, CONVEX-MIGRATION §5). This is the in-Convex replacement for the
   * Colyseus `MatchState`/`Mobile` schema (packages/server/.../MatchState.ts);
   * every authority mutation (plan 04) patches this doc and clients mirror it.
   *
   * `accountId` on each mobile is ALWAYS server-set from
   * `ctx.auth.getUserIdentity().subject` — NEVER read from client args (T-09-01);
   * the `get` query strips it from returned mobiles (T-09-02, plan 04).
   *
   * NOTE: this REUSES the table name `matches` previously held by the durability
   * ledger — which is now `matchDurability` below (review [F]). The one-off
   * `migrations.ts` that moved legacy rows under the old `matches` key into
   * `matchDurability` was deleted at the plan-12 Colyseus cutover (its job done).
   */
  matches: defineTable({
    // --- lifecycle ---
    status: v.union(
      v.literal("open"), // joinable, in lobby
      v.literal("full"), // seats filled, not started (locked out of lobby)
      v.literal("active"), // in play
      v.literal("ended"), // RESULTS
    ),
    mode: v.string(), // "1v1" | "2v2" | "4v4" | "training"
    name: v.string(), // lobby label
    // --- retention: idle-TTL cleanup (crons.ts → cleanup.sweep) ---
    // ms epoch of the last authority write (create/join/turn/shot/reset). The cron
    // deletes matches idle past CLEANUP_IDLE_MS and CASCADES matchTerrain+matchAim,
    // so ephemeral live-match state never accumulates. Optional so pre-field rows
    // validate; the sweep falls back to `_creationTime` for them. Uses an idle
    // timestamp (not status) so in-progress TRAINING — which has turnEndsAt:0 and
    // never reaches "ended" — is still protected while actively played.
    lastActivityAt: v.optional(v.number()),
    // --- turn machine (was MatchState scalars) ---
    phase: v.string(), // WAITING | TURN_START | AIMING | RESOLVING | RESULTS
    activeMobileId: v.string(), // was activePlayer; stable per-match mobile id, NOT a Colyseus sessionId
    wind: v.number(),
    turnEndsAt: v.number(), // ms epoch; 0 = no countdown (training)
    turnSeq: v.number(), // increments every startTurn — staleness guard for onTurnTimeout
    winnerTeam: v.number(), // -1 until set
    terrainVersion: v.number(), // bumps on every carve + on wholesale rebuild (training reset/respawn)
    // --- last resolved shot — replaces broadcast("shotResult") ---
    // Shapes below are the EXACT @shared/sim types (packages/shared/src/types.ts) — verbatim.
    lastShot: v.optional(
      v.object({
        seq: v.number(),
        byMobileId: v.string(),
        path: v.array(
          v.object({ x: v.number(), y: v.number(), t: v.number() }),
        ), // TrajectoryPoint { x, y, t }
        impact: v.union(
          v.object({ x: v.number(), y: v.number(), t: v.number() }),
          v.null(),
        ), // TrajectoryPoint | null
        carves: v.array(
          v.object({ cx: v.number(), cy: v.number(), r: v.number() }),
        ), // Carve { cx, cy, r }
        damage: v.array(
          v.object({ mechId: v.string(), amount: v.number() }),
        ), // Damage { mechId, amount } — mechId holds the mobileId
      }),
    ),
    // --- the mobiles (was MapSchema<Mobile>); powerLocked DROPPED (D6: no aim stream, timeout=skip) ---
    mobiles: v.array(
      v.object({
        mobileId: v.string(), // stable per-match id (crypto.randomUUID() at join, or "dummy")
        accountId: v.optional(v.string()), // null for the training dummy; server-set from identity, NEVER from client
        team: v.number(),
        x: v.number(),
        y: v.number(),
        hp: v.number(),
        angleDeg: v.number(),
        power: v.number(),
        selectedItemId: v.string(),
        accumulatedDelay: v.number(),
        ssHitCharge: v.number(),
        facing: v.number(), // 1 | -1
        ready: v.boolean(),
        passive: v.boolean(), // training dummy turn-exclusion; server-set only
        displayName: v.string(),
        connected: v.boolean(), // presence; default true
      }),
    ),
  })
    .index("by_status", ["status"]) // for lobby.listOpen
    .index("by_last_activity", ["lastActivityAt"]), // for cleanup.sweep idle-TTL

  /**
   * Authoritative terrain mask — RLE bytes, NOT on the reactive `matches` doc
   * (D1/D-11). Kept off the live doc so a carve does not balloon every patch;
   * `version` mirrors `matches.terrainVersion` at write time. `rle` is the
   * `encodeMaskRLE(...)` output as raw bytes (ArrayBuffer).
   */
  matchTerrain: defineTable({
    matchId: v.id("matches"),
    version: v.number(),
    rle: v.bytes(),
  }).index("by_match", ["matchId"]),

  /**
   * Optional live-aim stream (plan 10 wires `updateAim`). Created now so codegen
   * is stable and the aim wave adds ZERO schema churn. One row per aiming mobile;
   * `seq` is a monotonic staleness guard.
   */
  matchAim: defineTable({
    matchId: v.id("matches"),
    mobileId: v.string(),
    angleDeg: v.number(),
    seq: v.number(),
  }).index("by_match", ["matchId"]),

  /**
   * Match-level durability ledger (scoped attribution — Phase 08; RENAMED from
   * `matches` → `matchDurability` in Phase 9 to free the `matches` name for the
   * live doc above). Field shape + `by_room_id` index are UNCHANGED.
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
  matchDurability: defineTable({
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
