/**
 * Scheduled jobs (Phase 9). Convex has no automatic TTL, so retention is enforced
 * here: periodic sweeps delete the ephemeral live-match state (`matches` + its
 * `matchTerrain`/`matchAim` children) once idle, and prune the `result_events`
 * idempotency ledger. Durable data (`accounts`, `matchDurability`) is never touched.
 * Handlers + the full rationale live in `cleanup.ts`.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Delete idle matches (+ cascade terrain/aim). Every 15 min: well above the sweep's
// 30-min idle window, so even abandoned docs clear within ~one window of going idle.
crons.interval(
  "sweep idle matches",
  { minutes: 15 },
  internal.cleanup.sweepMatches,
  {},
);

// Prune expired idempotency rows. Hourly is ample for a 7-day TTL.
crons.interval(
  "sweep expired result_events",
  { hours: 1 },
  internal.cleanup.sweepResultEvents,
  {},
);

export default crons;
