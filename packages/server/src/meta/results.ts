/**
 * Meta API — match-results write seam (AUTH-05, Phase-5 Blocker 2).
 *
 * Real W/L persistence on Convex driven by per-player EXPLICIT OUTCOMES — NO
 * boolean win-flag, NO `winnerTeam === -1`-derived loss. The caller (plan 04
 * `endMatch` / plan 05 `removeAndForfeit`) supplies each player's explicit
 * `outcome` and a GRANULAR per-player+event `resultId` = `${roomId}:${event}:${accountId}`;
 * the Convex `recordResult` mutation dedups on that id via the `result_events`
 * table, so a retry OR a final/abandon overlap on the same room+player is a safe
 * no-op (no double-count, no draw-as-loss self-contradiction).
 *
 * The HTTP write PATH is gated in routes.ts (service auth + Zod + event-level
 * `resultId` idempotency — review H7). This body does the actual Convex write.
 *
 * Writes are fire-and-forget per player: the route has already responded 200, and
 * Convex `recordResult` is idempotent, so a transient failure is recovered by the
 * authoritative room re-issuing the same granular ids.
 */
import { getConvex, api } from "./convexClient.js";
import type { MatchResultMessage } from "@firewallops/match-core";

export type MatchResultPayload = MatchResultMessage;

export function recordMatchResult(payload: MatchResultPayload): void {
  for (const player of payload.players ?? []) {
    void getConvex().mutation(api.accounts.recordResult, {
      authUserId: player.accountId,
      outcome: player.outcome,
      resultId: player.resultId,
    });
  }
}
