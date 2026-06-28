/**
 * Pure headless turn machine (Phase 3, Plan 03) — NET-02, NET-03, NET-04.
 *
 * These are PURE functions over a minimal plain-data view (`TurnMobile`), so the
 * NET-02 gate, NET-03 transitions/win, and the NET-04 forfeit decision are all
 * unit-testable with NO live WebSocket server (mirrors the proven headless
 * MatchController pattern). The Room is a thin adapter that maps its `Mobile`
 * schema entries onto `TurnMobile` and applies the returned decisions.
 *
 * PURITY: imports NOTHING from the realtime engine packages — it stays a pure
 * decision layer (no @colyseus import; see the workspace lint seam).
 *
 * Phase 9 (D-02 timeout refactor): the timeout auto-fire helper and the
 * power-commit flag on `TurnMobile` were REMOVED here. The turn-timeout path is
 * now SKIP-ONLY — it never auto-fires a locked aim. The SKIP behavior (apply
 * FORFEIT_DELAY, advance, fire nothing) is implemented at the authority level in
 * the Convex onTurnTimeout mutation (plan 05); this pure layer no longer carries
 * the auto-fire surface so it cannot be accidentally re-ported. This is the ONE
 * intentional gameplay-behavior change in the migration (its human-verify
 * surfacing is plan 08).
 */

/**
 * The minimal per-mobile view the turn machine reads. The Room's `Mobile`
 * schema satisfies it structurally (sessionId/team/hp/accumulatedDelay are all
 * `@type()` fields).
 */
export interface TurnMobile {
  sessionId: string;
  team: number;
  hp: number;
  accumulatedDelay: number;
  /**
   * Turn-EXCLUSION marker (Phase 8). When `true`, `advanceTurn` NEVER selects
   * this mobile — the server-spawned training dummy carries `passive: true` so it
   * cannot take a turn. OPTIONAL so existing callers/tests that omit it are
   * unaffected: an undefined `passive` reads as not-passive.
   */
  passive?: boolean;
}

/**
 * The SINGLE pure `Mobile` → `TurnMobile` mapping (Phase 8, P0 boundary seam).
 *
 * `MatchRoom.turnView()` (Plan 02 Task 1) delegates to THIS helper so the
 * structural view that feeds `advanceTurn` ALWAYS carries `passive`. Before this
 * helper, `turnView()` inlined the mapping and DROPPED `passive` — which would let
 * the passive dummy win the turn in production and soft-lock the human behind the
 * active-player gate. This helper MUST forward `passive`. The `turnView mapping`
 * boundary test maps records through THIS function (the exact one the room uses),
 * so it catches a dropped-`passive` regression that a direct `advanceTurn` call
 * (with `passive` already set) would not.
 *
 * Phase 9 (D-02 timeout refactor): the power-commit flag is NO LONGER part of the
 * produced `TurnMobile` view. The caller's `Mobile` schema entry — which still
 * carries a synced commit flag — passes straight in as a variable (excess
 * properties on a variable are not an error), so the mapping simply drops it.
 */
export function toTurnMobile(m: {
  sessionId: string;
  team: number;
  hp: number;
  accumulatedDelay: number;
  passive?: boolean;
}): TurnMobile {
  return {
    sessionId: m.sessionId,
    team: m.team,
    hp: m.hp,
    accumulatedDelay: m.accumulatedDelay,
    passive: m.passive,
  };
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
    // Phase 8: a passive mobile (the server-spawned training dummy) is NEVER
    // selected, even with the lowest accumulatedDelay — it must not take a turn.
    if (m.passive) continue;
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
 * The forfeit-removal decision (RECON-04 / H1) — a PURE helper deciding (a)
 * whether the leaver was actually present (idempotency) and (b) the
 * post-removal team-elimination outcome. The Room is the SOLE mutator: it
 * deletes the mobile from the synced state and applies this decision; this
 * helper touches NO engine state and imports NOTHING from the realtime engine.
 *
 * Returned `outcome`:
 *   - `{ kind: "winner", team }` — exactly one team still has a living mobile.
 *   - `{ kind: "draw" }`         — no team has a living mobile (mutual wipe).
 *   - `{ kind: "continue" }`     — more than one team still living (match goes on).
 *
 * NOTE the `continue` rename: this is the FORFEIT outcome the Room branches on
 * (winner → endMatch, draw → endMatchDraw, continue → advance the turn). It maps
 * `checkWinTeam`'s `ongoing` to `continue` so the removal call site reads as a
 * removal decision, not a post-shot win check. This helper is W/L-outcome-free:
 * the abandoner ALWAYS takes `abandon_loss` (applied by the Room), independent of
 * the team-elimination decision computed here.
 *
 * Idempotent (H1 ghost guard): if `leaverSessionId` is NOT in `view`, the caller
 * already removed it — return `{ removed: false }` with the outcome of the view
 * as-is (no double removal, no double team-elim).
 */
export type ForfeitOutcome =
  | { kind: "winner"; team: number }
  | { kind: "draw" }
  | { kind: "continue" };

export function forfeitOutcome(
  view: TurnMobile[],
  leaverSessionId: string,
): { removed: boolean; outcome: ForfeitOutcome } {
  const present = view.some((m) => m.sessionId === leaverSessionId);
  const remaining = present
    ? view.filter((m) => m.sessionId !== leaverSessionId)
    : view;
  const win = checkWinTeam(remaining);
  const outcome: ForfeitOutcome =
    win.kind === "ongoing" ? { kind: "continue" } : win;
  return { removed: present, outcome };
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

// ─────────────────────────── Phase 8: training decisions ───────────────────────────
//
// PURE training decision helpers (Phase 8, Plan 02). These are the SHARED source
// of every training branch: the Room's thin adapter methods delegate to these,
// AND `training.test.ts` exercises the EXACT SAME functions (P1.1 — no parallel
// test copy). Both reviewers flagged that a test "modeling the branch the way the
// room does" can stay green while the real branch is wrong — that is HOW the P0
// `turnView` dropped-`passive` gap would have slipped through. Extracting the
// decision into one pure function the Room calls closes that drift: the test and
// production share one decision, not two copies. PURITY is preserved — these
// import NOTHING from the realtime engine and operate on plain records, not schema.

/**
 * The lobby-publish gate (TR-8): a training room is NEVER published to the lobby.
 * The Room calls this instead of re-inlining `!isTraining`, so the unlisted
 * invariant (one of the two highest-risk training invariants, previously locked
 * only by grep) is exercised by `training.test.ts` via the SAME function.
 */
export function shouldPublishToLobby(isTraining: boolean): boolean {
  return !isTraining;
}

/**
 * The match-result write gate (TR-8 stats integrity): a training quit/end NEVER
 * records a match result. Mirrors the existing `removeAndForfeit` abandon-write
 * condition exactly (`wasInProgress && hasAccountId`) PLUS the training veto, so
 * the Room can gate the abandon write on the SAME predicate the test asserts —
 * a double-lock on the no-stats invariant.
 */
export function shouldRecordResult(
  isTraining: boolean,
  wasInProgress: boolean,
  hasAccountId: boolean,
): boolean {
  return !isTraining && wasInProgress && hasAccountId;
}

/**
 * The player-invincible HP write-back gate (TR-7). Returns TRUE if the resolve
 * HP write-back SHOULD happen for this mech, FALSE if it must be SKIPPED. In
 * training the firing player takes NO self-splash: the player's OWN mobile HP is
 * never written down (FALSE for `mechId === activeSessionId`), but the dummy's HP
 * IS written (TRUE), so the dummy still takes damage and can die. In a real match
 * everyone's HP is written (TRUE). The Room's resolve loop and the `invincible`
 * test call this exact predicate.
 */
export function applyTrainingHpWriteBack(
  isTraining: boolean,
  mechId: string,
  activeSessionId: string,
): boolean {
  return !(isTraining && mechId === activeSessionId);
}

/**
 * The respawn-not-end decision (TR-4): in training a dummy at HP<=0 is respawned
 * (with fresh terrain) and the match CONTINUES — it NEVER ends. Returns TRUE when
 * the dummy is dead (→ respawn), FALSE when alive (→ just continue). The Room's
 * `afterResolve` training branch delegates here; the `respawn` test asserts the
 * same boundary.
 */
export function shouldTrainingRespawn(dummyHp: number): boolean {
  return dummyHp <= 0;
}

/**
 * The manual-RESET-only player shot-state wipe (TR-5). MUTATES the passed record
 * back to a clean turn: SS charge cleared, default shot re-selected, power/delay
 * zeroed, angle re-centered. A `Mobile` schema entry satisfies this structurally,
 * so the Room's `resetPlayerShotState()` passes the human mobile straight in — the
 * SAME function the test exercises on a plain record.
 *
 * Phase 9 (D-02 timeout refactor): this no longer touches the power-commit flag.
 * The synced commit flag on the Mobile schema still exists, but it is reset at
 * turn-start by the Room (`startTurn`), not by this RESET wipe; the timeout path no
 * longer reads it (auto-fire removed), so this helper drops that reset entirely.
 *
 * CALL ONLY from the manual-RESET path. A kill-RESPAWN deliberately PRESERVES the
 * player's earned `ssHitCharge` (the respawn helper touches only the dummy +
 * terrain, never the player record), so do NOT call this from the respawn path.
 */
export function resetPlayerShotStateOn(rec: {
  ssHitCharge: number;
  selectedItemId: string;
  power: number;
  accumulatedDelay: number;
  angleDeg: number;
}): void {
  rec.ssHitCharge = 0;
  rec.selectedItemId = "shot-1";
  rec.power = 0;
  rec.accumulatedDelay = 0;
  rec.angleDeg = 45;
}

/**
 * The start-with-1 gate (TR-1): a training room starts the instant the single
 * human is seated — it BYPASSES the ready handshake (`shouldAutoStart`). Returns
 * TRUE only for a training room with at least one human. A real match returns
 * FALSE here (it must go through the ready/auto-start path instead). The Room's
 * `onJoin` training branch is gated on this; the `start-with-1` test asserts the
 * bypass against `shouldAutoStart`.
 */
export function shouldStartImmediately(
  isTraining: boolean,
  humanCount: number,
): boolean {
  return isTraining && humanCount >= 1;
}
