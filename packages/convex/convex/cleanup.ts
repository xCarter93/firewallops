/**
 * Retention / data-cleanup sweeps (Phase 9). Registered on a schedule by
 * `crons.ts`. The pure-Convex backend writes one ephemeral live-match doc per game
 * (`matches`) plus its `matchTerrain` (RLE) and `matchAim` (live aim) children, and
 * an idempotency row per player+event (`result_events`). NONE of these were ever
 * deleted before this module — they accumulated forever (every training entry and
 * every multiplayer match left rows behind).
 *
 * WHAT IS *NOT* TOUCHED (durable by design — see schema.ts):
 *   - `accounts`        — player profile + W/L, kept forever.
 *   - `matchDurability` — write-only roster/outcome audit log, kept long-term.
 * The durable records are written BEFORE the live doc dies (W/L → accounts via
 * recordResult; roster/winner → matchDurability), so deleting `matches` /
 * `matchTerrain` / `matchAim` loses nothing permanent.
 *
 * MECHANISM — idle TTL, not status. A match is swept once it has been idle past
 * `CLEANUP_IDLE_MS` (no create/join/turn/shot/reset write since). Idle-based (vs
 * "delete status==='ended'") specifically because TRAINING never reaches a terminal
 * status — it has `turnEndsAt:0` and no win condition — so a status filter would
 * leak every training doc forever. `lastActivityAt` is refreshed on every authority
 * write (match.ts / match_internal.ts), so an actively-played match (any mode) is
 * never stale; an ended/abandoned/idle one falls past the threshold within minutes
 * of its last turn. Pre-field rows (no `lastActivityAt`) sort first in the index and
 * are swept on the first run (they are stale test artifacts).
 */
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Idle window before a match (and its terrain/aim children) is deleted. Comfortably
 * above any real session: an active match refreshes `lastActivityAt` every turn
 * (≤ TURN_MS + dwell ≈ 25s apart), and an ended match's banner is read within
 * seconds — so 30 min never interrupts live play yet bounds storage tightly.
 */
const CLEANUP_IDLE_MS = 30 * 60 * 1000;

/**
 * Idempotency ledger TTL. A `result_events` row only guards against a retried W/L
 * write, which can only happen in the minutes around a match end — 7 days is far
 * past any retry while still bounding the (tiny but unbounded) table.
 */
const RESULT_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-run caps. Each match delete cascades to ~1 terrain + ≤8 aim + the doc itself
 * (and reads the full live doc), so cap matches lower than the tiny result rows to
 * stay well inside a single mutation's read/write budget. A backlog drains over
 * successive cron runs.
 */
const MATCH_BATCH = 50;
const RESULT_BATCH = 200;

/**
 * Delete matches idle past CLEANUP_IDLE_MS, CASCADING their `matchTerrain` +
 * `matchAim` children so no orphans are left. Cron entry (crons.ts).
 */
export const sweepMatches = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - CLEANUP_IDLE_MS;

    // Oldest-idle first (index order). Rows missing `lastActivityAt` sort before all
    // numbers, so legacy/test rows are caught here too.
    const stale = await ctx.db
      .query("matches")
      .withIndex("by_last_activity", (q) => q.lt("lastActivityAt", cutoff))
      .take(MATCH_BATCH);

    let deletedMatches = 0;
    let deletedTerrain = 0;
    let deletedAim = 0;

    for (const match of stale) {
      // Belt-and-suspenders: never delete a match with a turn deadline still in the
      // future (a genuinely live turn). An active match keeps `lastActivityAt` fresh
      // so it should never reach this set, but a future `turnEndsAt` is an
      // independent proof of liveness — skip it and let a later run reconsider.
      if (match.status === "active" && match.turnEndsAt > now) continue;

      const matchId = match._id as Id<"matches">;

      const terrain = await ctx.db
        .query("matchTerrain")
        .withIndex("by_match", (q) => q.eq("matchId", matchId))
        .collect();
      for (const row of terrain) {
        await ctx.db.delete(row._id);
        deletedTerrain += 1;
      }

      const aim = await ctx.db
        .query("matchAim")
        .withIndex("by_match", (q) => q.eq("matchId", matchId))
        .collect();
      for (const row of aim) {
        await ctx.db.delete(row._id);
        deletedAim += 1;
      }

      await ctx.db.delete(match._id);
      deletedMatches += 1;
    }

    return { deletedMatches, deletedTerrain, deletedAim, scanned: stale.length };
  },
});

/**
 * Prune `result_events` idempotency rows older than RESULT_EVENT_TTL_MS, using the
 * built-in `by_creation_time` system index. Cron entry (crons.ts).
 */
export const sweepResultEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RESULT_EVENT_TTL_MS;

    const stale = await ctx.db
      .query("result_events")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(RESULT_BATCH);

    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    return { deletedResultEvents: stale.length };
  },
});
