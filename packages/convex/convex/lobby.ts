/**
 * Lobby / open-room list (Phase 9, Plan 04) — replaces `LobbyRoom` +
 * `MatchRoom.refreshListing`/`setMetadata`.
 *
 * `listOpen` is a REACTIVE query: clients `onUpdate(api.lobby.listOpen, {})` and
 * the list re-pushes whenever a room's status/roster/phase changes — the Convex
 * equivalent of Colyseus' lobby `updateLobby(this)` fan-out.
 *
 * [G] (review, MEDIUM): the list includes BOTH `status === "open"` AND
 * `status === "full"`, and EXCLUDES `active`/`ended`. This matches Colyseus'
 * `refreshListing()` (`MatchRoom.ts:276-298`), which keeps a FULL-but-not-yet-
 * started room LISTED (with `locked: true`) and only stops listing once the match
 * starts (`active`) or ends (`ended`). Filtering on `status !== "open"` instead
 * would make full waiting rooms VANISH from the lobby — an LOBBY-01/02 parity
 * regression. `locked` is therefore derived from `seatsFull(players, teamSize)`
 * OR `phase !== "WAITING"` (the exact `MatchRoom.ts:285-286` rule), NOT from the
 * status.
 *
 * [R2] `accountId` NEVER appears in the returned shape: this query returns only
 * non-identifying lobby-display summary fields (id/name/mode/counts/locked/phase),
 * not the `mobiles[]` array. Because the summary is non-identifying, the lobby
 * list itself needs no membership gate (unlike `match.get`/`getTerrain`).
 */
import { query } from "./_generated/server";
import {
  seatsFull,
  teamSizeForMode,
  type MatchMode,
} from "@firewallops/match-core";

export const listOpen = query({
  args: {},
  handler: async (ctx) => {
    // [G] open + full only (exclude active/ended). Query each visible status via
    // the `by_status` index (no full-table scan), then merge.
    const open = await ctx.db
      .query("matches")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect();
    const full = await ctx.db
      .query("matches")
      .withIndex("by_status", (q) => q.eq("status", "full"))
      .collect();

    return [...open, ...full].map((m) => {
      const teamSize = teamSizeForMode(m.mode as MatchMode);
      const players = m.mobiles.length;
      const readyCount = m.mobiles.filter((mob) => mob.ready).length;
      // [G] locked from seatsFull / phase — the MatchRoom.ts:285-286 rule, NOT
      // `status !== "open"`.
      const locked = m.phase !== "WAITING" || seatsFull(players, teamSize);
      // [R2] summary fields ONLY — no accountId, no mobiles[].
      return {
        matchId: m._id,
        name: m.name,
        mode: m.mode,
        players,
        maxPlayers: teamSize * 2,
        readyCount,
        locked,
        phase: m.phase,
      };
    });
  },
});
