/**
 * Meta API — match-level durability write seam (scoped attribution, Phase 08).
 *
 * Fire-and-forget Convex writes that record WHO was in a match and how it ended,
 * mirroring the `results.ts` pattern (one `ConvexHttpClient` via `convexClient`).
 * Unlike `results.ts`, these are wrapped in `safeMutation` so a missing
 * `CONVEX_URL` or a transient Convex failure can NEVER break game flow —
 * durability here is best-effort and supplementary (the authoritative match
 * outcome is unaffected). `recordMatchStart` runs on every real match start, so
 * it must not throw even when Convex is unconfigured (e.g. local dev).
 */
import { getConvex, api } from "./convexClient.js";
import type { MatchStartPlayer } from "../match/matchPersistence.js";

/** Record the match roster at start (idempotent upsert on roomId). No-op if empty. */
export function recordMatchStart(
  roomId: string,
  mode: string,
  players: MatchStartPlayer[],
): void {
  if (players.length === 0) return;
  safeMutation(() =>
    getConvex().mutation(api.matches.recordStart, { roomId, mode, players }),
  );
}

/** Record the terminal match status (first terminal write wins, server-side). */
export function recordMatchEnd(
  roomId: string,
  status: "ended" | "abandoned",
  winnerTeam?: number,
): void {
  // Omit winnerTeam when unknown — Convex values do not carry `undefined`.
  const args =
    winnerTeam === undefined
      ? { roomId, status }
      : { roomId, status, winnerTeam };
  safeMutation(() => getConvex().mutation(api.matches.recordEnd, args));
}

/**
 * Run a fire-and-forget Convex mutation that must never break the match. Catches
 * BOTH the synchronous throw (CONVEX_URL unset → `getConvex()` throws) and the
 * async rejection (network/Convex error), logging a non-fatal warning.
 */
function safeMutation(run: () => Promise<unknown>): void {
  try {
    void run().catch((err: unknown) => {
      console.warn("[match] durability write failed (non-fatal)", err);
    });
  } catch (err) {
    console.warn("[match] durability write skipped (convex unavailable)", err);
  }
}
