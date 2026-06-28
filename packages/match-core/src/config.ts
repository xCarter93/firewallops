/**
 * Server room tuning constants — the SINGLE tuning surface for Phase 3.
 *
 * Every in-room scheduling concern (turn timers, dwell, forfeit) is driven by
 * the values here, and ALL in-room scheduling MUST go through `this.clock`
 * (Colyseus `ClockTimer`), never a raw `setTimeout`/`setInterval` (NET-04
 * discipline). Raw timers are not cleaned up on room dispose and leak across
 * matches — Plan 03 schedules every timer via `this.clock.setTimeout(...)`.
 *
 * Several constants deliberately mirror the Phase 2 client `MatchState` tuning
 * (WIND_MIN/MAX, GRAVITY, SS_HITS_TO_ARM) so the server-authoritative feel
 * matches what the hotseat client established.
 */

/** Per-turn wall-clock length (~20s tunable turn, NET-04). */
export const TURN_MS = 20_000;

/**
 * Short dwell the Room holds `TURN_START` before transitioning to `AIMING`,
 * so Colyseus patch batching does not collapse the two phases into a single
 * tick. This makes `TURN_START` observable by clients (success criterion #2).
 * Plan 03 schedules this transition via `this.clock`.
 */
export const TURN_START_DWELL_MS = 300;

/**
 * Forfeit-delay penalty added to a skipped player's delay accumulator so the
 * delay queue keeps advancing past a never-aiming player. Chosen LARGER than
 * the heaviest real per-shot turnDelay (TROJAN = 40) so a player who never
 * aims keeps yielding the turn instead of re-acquiring it — otherwise a
 * 40-delay opponent could starve the queue against a 0-delay forfeiter.
 */
export const FORFEIT_DELAY = 50;

/** Wind roll range (signed horizontal accel) — mirrors the client MatchState. */
export const WIND_MIN = -80;
export const WIND_MAX = 80;

/** Gravity constant — mirrors the client GRAVITY / Phase 1 tuning baseline. */
export const GRAVITY = 300;

/**
 * Landed-damage count that arms the Trojan (SS). The server now owns SS-charge
 * authoritatively (Authority Decision 5); the Plan 03 Trojan-arming gate reads
 * this — a `trojan` fire is rejected while `ssHitCharge < SS_HITS_TO_ARM`.
 */
export const SS_HITS_TO_ARM = 3;

/**
 * Documented aim-stream cadence. The actual throttle is client-side (Plan 04);
 * exported here so both sides reference one number.
 */
export const AIM_THROTTLE_MS = 100;

/**
 * Post-impact settle beat (ms) the Room dwells in RESOLVING AFTER the shot's
 * flight, before advancing the turn — covers the client impact FX + mech-settle
 * tween so the turn does NOT flip the instant the shot is fired. Mirrors the
 * hotseat POST_IMPACT feel.
 */
export const RESOLVE_SETTLE_MS = 600;

/**
 * Client shot-flight timing MIRROR (packages/client/src/view/ProjectileView.ts):
 * the dot advances PROJECTILE_PTS_PER_MS path samples/ms, clamped to
 * [PROJECTILE_MIN_FLIGHT_MS, PROJECTILE_MAX_FLIGHT_MS]. The Room dwells in
 * RESOLVING for the SAME computed flight + RESOLVE_SETTLE_MS so the
 * server-driven turn advance waits for the client animation. KEEP IN SYNC with
 * ProjectileView — a drift only loosens the dwell, it cannot desync authority.
 */
export const PROJECTILE_PTS_PER_MS = 0.06;
export const PROJECTILE_MIN_FLIGHT_MS = 600;
export const PROJECTILE_MAX_FLIGHT_MS = 1200;

/**
 * The RESOLVING dwell (ms) the Room holds before advancing the turn / ending the
 * match: the client's clamped flight time for `pathLength` trajectory samples
 * plus the post-impact settle beat. Pure — unit-tested in resolveTiming.test.ts.
 */
export function resolveDwellMs(pathLength: number): number {
  const flight = Math.min(
    PROJECTILE_MAX_FLIGHT_MS,
    Math.max(PROJECTILE_MIN_FLIGHT_MS, pathLength / PROJECTILE_PTS_PER_MS),
  );
  return flight + RESOLVE_SETTLE_MS;
}

export type MatchMode = "1v1" | "2v2" | "4v4" | "training";

/**
 * Per-mode PER-TEAM size (total seats = `teamSizeForMode(mode) * 2`). The room
 * now derives its `teamSize` from its CREATE-OPTION mode (Plan 04, LOBBY-03) —
 * mode is a per-room concern, NOT a global constant. `MATCH_CONFIG` below is kept
 * only as a local-dev default.
 *
 * `"training"` is a SINGLE-HUMAN mode (Phase 8): teamSize 1 = one human seat, but
 * the room ALSO hosts a server-spawned passive dummy mobile (team 1) that does
 * NOT consume a human seat — the room hard-caps `maxClients = 1` in Plan 02 (it
 * does NOT use the `teamSize * 2` seat math the competitive modes use).
 */
export function teamSizeForMode(mode: MatchMode): number {
  return mode === "4v4"
    ? 4
    : mode === "2v2"
      ? 2
      : mode === "training"
        ? 1
        : 1;
}

/**
 * LOCAL-DEV DEFAULT ONLY (CONTEXT: default 1v1). `teamSize` is PER-TEAM, so total
 * seats = `teamSize * 2`.
 *
 * As of Plan 04 the MatchRoom NO LONGER reads `teamSize` from this constant — it
 * derives `teamSize` from its per-room create-option `mode` via
 * `teamSizeForMode(mode)`. This export remains for any local-dev / legacy
 * reference; it is no longer the room's source of truth.
 */
export const MATCH_CONFIG: { mode: MatchMode; teamSize: number } = {
  mode: "1v1",
  teamSize: 1,
};
