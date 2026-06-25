/**
 * Pure helper for the scoped match-state durability seam (Phase 08 follow-up).
 *
 * Builds the durable per-match roster (player → account → team) from the room's
 * mobiles + the PRIVATE sessionId→accountId map. Kept pure (no Convex, no I/O,
 * no schema types) so it is unit-testable headless, mirroring the discipline of
 * `turnMachine.ts`. A mobile with NO bound accountId (the training dummy, or a
 * not-yet-authed seat) is skipped — only real, attributable players are recorded.
 */

/** The durable roster entry persisted per player. */
export interface MatchStartPlayer {
  accountId: string;
  team: number;
  displayName: string;
}

/** The minimal mobile shape the builder reads (a subset of the synced Mobile). */
export interface PersistableMobile {
  sessionId: string;
  team: number;
  displayName: string;
}

/**
 * Project the seated mobiles into the durable roster, attaching each one's bound
 * accountId and dropping any mobile without one (e.g. the passive training dummy).
 */
export function buildMatchStartPlayers(
  mobiles: readonly PersistableMobile[],
  accountIds: ReadonlyMap<string, string>,
): MatchStartPlayer[] {
  const players: MatchStartPlayer[] = [];
  for (const m of mobiles) {
    const accountId = accountIds.get(m.sessionId);
    if (!accountId) continue; // no bound account (dummy / unauthed) — not attributable.
    players.push({ accountId, team: m.team, displayName: m.displayName });
  }
  return players;
}
