/**
 * Pure headless turn machine (Phase 3, Plan 03) — NET-02, NET-03, NET-04.
 *
 * These are PURE functions over a minimal plain-data view (`TurnMobile`), so the
 * NET-02 gate, NET-03 transitions/win, and the NET-04 forfeit decision are all
 * unit-testable with NO live WebSocket server (mirrors the proven headless
 * MatchController pattern). The Room is a thin adapter that maps its `Mobile`
 * schema entries onto `TurnMobile` and applies the returned decisions.
 *
 * PURITY: imports NOTHING from @colyseus/core or @colyseus/schema — it stays a
 * pure decision layer.
 */

/**
 * The minimal per-mobile view the turn machine reads. The Room's `Mobile`
 * schema satisfies it structurally (sessionId/team/hp/accumulatedDelay/
 * powerLocked are all `@type()` fields).
 */
export interface TurnMobile {
  sessionId: string;
  team: number;
  hp: number;
  accumulatedDelay: number;
  powerLocked: boolean;
}

/** The five server-driven phases (NET-03 state machine). */
export const PHASES = [
  "WAITING",
  "TURN_START",
  "AIMING",
  "RESOLVING",
  "RESULTS",
] as const;
export type Phase = (typeof PHASES)[number];

/**
 * The delay-queue turn order (PLAY-06, NET-03): the LIVING mobile (hp > 0) with
 * the lowest `accumulatedDelay` acts next; ties break by array order (stable).
 *
 * Generalizes MatchController.advanceTurn to filter to living mobiles and return
 * the sessionId (the Room then sets `state.activePlayer`). Turn order is across
 * ALL living mobiles regardless of team — teams only change the WIN check.
 *
 * Throws if there is no living mobile (the caller must have already resolved the
 * match via checkWinTeam before calling this).
 */
export function advanceTurn(mobiles: TurnMobile[]): string {
  let next: TurnMobile | undefined;
  for (const m of mobiles) {
    if (m.hp <= 0) continue;
    if (next === undefined || m.accumulatedDelay < next.accumulatedDelay) {
      next = m;
    }
  }
  if (next === undefined) {
    throw new Error("advanceTurn: no living mobile to advance to");
  }
  return next.sessionId;
}

/**
 * The win outcome (Codex MEDIUM — the simultaneous-wipe draw path replaces the
 * old `number | null`, which left mutual elimination undefined).
 */
export type WinOutcome =
  | { kind: "winner"; team: number }
  | { kind: "draw" }
  | { kind: "ongoing" };

/**
 * Last-team-standing win check (NET-03), generalizing last-mech-standing to the
 * 2-team model AND handling mutual elimination:
 *   - exactly ONE team has a living mobile  → { kind: "winner", team }
 *   - MORE than one team still has a living mobile → { kind: "ongoing" }
 *   - ZERO teams have a living mobile (one resolve wiped the last mobiles of all
 *     remaining teams) → { kind: "draw" }
 *
 * The Room broadcasts `matchEnded` on "winner" AND "draw" — the result is NEVER
 * left undefined.
 */
export function checkWinTeam(mobiles: TurnMobile[]): WinOutcome {
  const livingTeams = new Set<number>();
  for (const m of mobiles) {
    if (m.hp > 0) livingTeams.add(m.team);
  }
  if (livingTeams.size === 1) {
    return { kind: "winner", team: [...livingTeams][0] };
  }
  if (livingTeams.size === 0) {
    return { kind: "draw" };
  }
  return { kind: "ongoing" };
}

/**
 * Auto-balance team assignment by join order within `teamSize` (Cursor/Codex LOW
 * — must enforce teamSize, not merely alternate).
 *
 * For the 2-team configs this phase ships (1v1 / 2v2 / 4v4), total seats are
 * `teamSize * 2` and seats fill A,B,A,B,… so `joinOrder % 2` is the team. The
 * Room rejects overflow joiners BEFORE calling this (onJoin checks `seatsFull`),
 * so the per-team count never exceeds `teamSize`: `joinOrder % 2` keeps both
 * teams within `teamSize` because the Room locks at `teamSize*2` seats.
 *
 * Balanced 2-team only this phase. `teamSize` is accepted to make the contract
 * explicit (and to assert it in tests) even though the modulo math does not vary
 * by it for the balanced case.
 */
export function assignTeam(joinOrder: number, _teamSize: number): number {
  return joinOrder % 2;
}

/** True once every seat is filled — total seats are `teamSize * 2`. */
export function seatsFull(mobileCount: number, teamSize: number): boolean {
  return mobileCount >= teamSize * 2;
}

/**
 * The auto-start gate (LOBBY-04): the match auto-starts ONLY when the room is
 * full AND every seated mobile is ready — there is NO manual master Start.
 *
 * PURE (no Colyseus import): the Room maps its synced mobiles to a count + a
 * `readyFlags` boolean[] (one flag per mobile, in seat order) and delegates the
 * decision here. `readyFlags.length === mobileCount` guards against a stale /
 * partial snapshot (a flag must exist for every counted seat), and
 * `readyFlags.every(Boolean)` requires unanimous ready. Locking-on-full is a
 * SEPARATE concern owned by the Room (a full-but-not-ready room is still locked
 * and admits no further clients) — this gate decides only START.
 */
export function shouldAutoStart(
  mobileCount: number,
  teamSize: number,
  readyFlags: boolean[],
): boolean {
  return (
    seatsFull(mobileCount, teamSize) &&
    readyFlags.length === mobileCount &&
    readyFlags.every(Boolean)
  );
}

/**
 * The turn-timeout decision (NET-04). If the active mobile has COMMITTED power
 * (`powerLocked`) the Room auto-fires its last streamed aim; otherwise the Room
 * SKIPS the turn and applies FORFEIT_DELAY. The FORFEIT_DELAY add stays in the
 * Room (it mutates schema), but this pure decision makes the branch testable.
 */
export type TimeoutOutcome = { kind: "auto-fire" } | { kind: "skip" };

export function timeoutOutcome(active: TurnMobile): TimeoutOutcome {
  return active.powerLocked ? { kind: "auto-fire" } : { kind: "skip" };
}

/**
 * The active-player + phase gate (NET-02) as a pure predicate. A fire/aim is
 * accepted ONLY when the room is in the AIMING phase AND the sender is the
 * active player. The Room's `fire`/`aim` handlers call this BEFORE any game
 * logic; failing input is silently dropped.
 */
export function canFire(
  phase: string,
  senderId: string,
  activePlayer: string,
): boolean {
  return phase === "AIMING" && senderId === activePlayer;
}

/**
 * The FULL fire-acceptance predicate (NET-02 + NET-07-arming): a `fire` is
 * accepted ONLY when the active-player + phase gate passes AND, for a `trojan`
 * fire, the SS charge is armed (Authority Decision 5). This is the single source
 * of "does this fire resolve or get dropped?" so the Room handler and the
 * gate-before-logic integration tests share ONE decision — a dropped fire never
 * reaches the resolver.
 *
 * `ssHitCharge` / `ssHitsToArm` only matter for the Trojan; a `shot-1`/`shot-2`
 * fire ignores them.
 */
export function shouldResolveFire(args: {
  phase: string;
  senderId: string;
  activePlayer: string;
  itemId: string;
  ssHitCharge: number;
  ssHitsToArm: number;
}): boolean {
  if (!canFire(args.phase, args.senderId, args.activePlayer)) return false;
  if (args.itemId === "trojan" && args.ssHitCharge < args.ssHitsToArm) {
    return false;
  }
  return true;
}
