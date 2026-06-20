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

export type MatchMode = "1v1" | "2v2" | "4v4";

/**
 * Throwaway two-tab test config (CONTEXT: default 1v1). `teamSize` is PER-TEAM,
 * so total seats = `teamSize * 2`. Edit `teamSize` to 2 (2v2) or 4 (4v4) to
 * test the other modes locally.
 */
export const MATCH_CONFIG: { mode: MatchMode; teamSize: number } = {
  mode: "1v1",
  teamSize: 1,
};
