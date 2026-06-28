/**
 * Thin durability-alias module (review [A2]) — dual-stack compatibility shim.
 *
 * The durability mutations moved to `matchDurability.ts` in Phase 9 (the
 * `matches` module/table name is now the LIVE authoritative match doc). The LIVE
 * Railway Colyseus server still calls `api.matches.recordStart` /
 * `api.matches.recordEnd` (packages/server/src/meta/matches.ts:23/38) during the
 * dual-stack migration window. Re-exporting the SAME function symbols here keeps
 * those callsites resolving against `matchDurability`'s handlers — no repoint of
 * the soon-to-be-deleted server, lowest churn.
 *
 * DELETE this file in plan 12 (the Colyseus cutover) along with packages/server.
 *
 * NOTE: this file exports ONLY the two durability functions. It does NOT (and
 * must not) re-export anything from the live-match modules — `api.matches.*`
 * means durability here until cutover; the live match API lives under `match.ts`
 * (plan 04).
 */
export { recordStart, recordEnd } from "./matchDurability.js";
