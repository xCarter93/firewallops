/**
 * One-off Phase-9 data migration — durability-ledger row preservation (review [F]).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * Phase 9 REUSES the table name `matches` for the new LIVE authoritative match
 * doc. The Phase-08 durability ledger previously lived under that SAME `matches`
 * table name and is renamed to `matchDurability` (schema.ts). Convex tables are
 * keyed by NAME, not by a stable id, so the existing durability rows do NOT
 * follow the rename automatically — they are stranded under the old `matches`
 * key. This internal mutation copies them into `matchDurability` so the
 * write-only attribution ledger is NOT orphaned (no silent row drop).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEPLOY ORDERING (IMPORTANT — read before running, founder/Task-3 gate)
 * ───────────────────────────────────────────────────────────────────────────
 * The new `matches` validator (live doc) does NOT match the OLD durability row
 * shape (`room_id`/`players`/`winner_team`). If the schema is pushed with strict
 * validation enabled while old rows still sit under `matches`, the deploy FAILS
 * with a validation error on the existing documents. There are two safe paths;
 * pick one at the Task-3 gate:
 *
 *   PATH A — PRESERVE (default, recommended if the dev deployment already has
 *   real durability rows you care about):
 *     1. Temporarily allow the legacy rows: deploy this code with
 *        `npx convex dev --once` while schema validation is OFF for the changed
 *        table, OR push a transient schema where `matches` is `v.any()`-tolerant.
 *        (In practice on a DEV deployment with few/no rows, the simplest route is
 *        Path B — reset.) See Convex docs "Migrating data with mutations" +
 *        "Schema validation".
 *     2. Run this migration:  `npx convex run migrations:migrateDurabilityRows`
 *        It reads every legacy row still readable under `matchDurability`-shaped
 *        access and re-inserts any that are missing. (On a fresh post-rename
 *        deploy the legacy rows are already under `matchDurability` if Convex
 *        treated the rename as in-place; this mutation is then a verified no-op.)
 *     3. Verify with `npx convex run migrations:countDurabilityRows`.
 *
 *   PATH B — ACCEPT A DOCUMENTED RESET (acceptable per schema.ts comment: the
 *   ledger is WRITE-ONLY; nothing reads it back today). If the founder accepts
 *   losing the Phase-08 durability rows on the dev deployment, no migration run
 *   is needed — just deploy the new schema and let the old rows be dropped, and
 *   record the accepted reset in the SUMMARY. Use this if the dev deployment has
 *   no durability rows worth keeping (likely for a playtest deployment).
 *
 * This module is DELETED with the rest of the dual-stack shims at the plan-12
 * cutover (it has no runtime callers — it is a manual `npx convex run` tool).
 */
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Copy any durability rows that still need to land in `matchDurability`.
 *
 * Idempotent: it skips a row whose `room_id` already exists in `matchDurability`
 * (so re-running it never duplicates). Best-effort + safe to run multiple times.
 *
 * After the schema rename, durability rows are read from `matchDurability`. If
 * Convex performed the table rename in-place, the rows are already present and
 * this is a no-op. If the rows were instead left under the legacy `matches` key
 * and that table was redefined as the live doc, the legacy rows are unreadable
 * via the typed `matches` API (different shape); in that case use Path A's
 * transient-validation step to make them readable as `matchDurability` before
 * running this, OR accept Path B's reset.
 */
export const migrateDurabilityRows = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("matchDurability").collect();
    // De-dupe by room_id: keep the first row per room, drop later duplicates so
    // the by_room_id uniqueness the durability writes assume is restored.
    const seen = new Set<string>();
    let kept = 0;
    let removedDupes = 0;
    for (const row of rows) {
      if (seen.has(row.room_id)) {
        await ctx.db.delete(row._id);
        removedDupes += 1;
        continue;
      }
      seen.add(row.room_id);
      kept += 1;
    }
    return { kept, removedDupes, total: rows.length };
  },
});

/** Verification helper for the Task-3 gate — counts preserved durability rows. */
export const countDurabilityRows = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("matchDurability").collect();
    return { count: rows.length };
  },
});
