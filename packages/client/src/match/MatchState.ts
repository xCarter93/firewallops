import type { Mech } from "@shared/sim";

/**
 * Local match state model (Phase 2, plan 02) — TECHNICAL-DESIGN §5.1.
 *
 * Pure data: NO phaser, NO baked-in randomness (the wind roll takes an injected
 * RNG so tests can seed it). In Phase 3 the authoritative copy of this shape
 * lives on the Colyseus room; here it is the local hotseat source of truth that
 * `MatchController` reads and mutates.
 */

/** Number of damaging hits a player must land before the Trojan (SS) arms. */
export const SS_HITS_TO_ARM = 3;
/** Per-turn horizontal move allowance (px). */
export const MOVE_BUDGET_PER_TURN = 120;
/** Wind roll range (signed horizontal accel passed to the sim as ShotInput.wind). */
export const WIND_MIN = -80;
export const WIND_MAX = 80;
/** Gravity constant — matches the harness / Phase 1 tuning baseline. */
export const GRAVITY = 300;

/** Per-player turn-economy state. */
export interface PlayerState {
  id: string;
  /** Delay-queue accumulator: lowest acts next (PLAY-06). */
  accumulatedDelay: number;
  /** Damaging-hit counter; at SS_HITS_TO_ARM the Trojan is armed. */
  ssHitCharge: number;
  /** Remaining horizontal move budget this turn. */
  moveBudget: number;
  /**
   * Aim facing (02-04 NO-GO fix 2): +1 = facing right (aim 0=right…90=up),
   * -1 = facing left (aim mirrored to 180=left…90=up). Client-only turn state —
   * NOT a `@shared/sim` Mech field (that type is frozen). The on-screen aim
   * angle stays 0–90 relative to this; `buildShotInput` converts it to the sim's
   * absolute angle. Initial facing points toward the opponent / map center;
   * pressing ←/→ flips it so a player can aim the way they last moved.
   */
  facing: 1 | -1;
}

/** The whole local match. `mechs` is the array `resolveShot` damages. */
export interface MatchState {
  mechs: Mech[];
  players: PlayerState[];
  wind: number;
  gravity: number;
  activePlayerId: string;
}

/**
 * Build the opening state: P1 (players[0]) active, all delay/charge zeroed and
 * move budget full, wind 0 (rolled at the first turn start), default gravity.
 *
 * Each player may declare an initial `facing` (02-04 NO-GO fix 2); it defaults
 * to +1 (facing right) when omitted so headless callers that don't care keep
 * working. The Scene passes P1 → +1 (faces right, toward center) and P2 → -1
 * (faces left, toward center).
 */
export function createInitialState(
  mechs: Mech[],
  players: { id: string; facing?: 1 | -1 }[],
): MatchState {
  if (players.length === 0) {
    throw new Error("createInitialState requires at least one player");
  }
  return {
    mechs,
    players: players.map((p) => ({
      id: p.id,
      accumulatedDelay: 0,
      ssHitCharge: 0,
      moveBudget: MOVE_BUDGET_PER_TURN,
      facing: p.facing ?? 1,
    })),
    wind: 0,
    gravity: GRAVITY,
    activePlayerId: players[0].id,
  };
}
