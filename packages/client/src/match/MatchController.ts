import {
  simulateTrajectory,
  resolveShot,
  TerrainMask,
} from "@shared/sim";
import type {
  Carve,
  Damage,
  ProjectileDef,
  ShotInput,
  TrajectoryPoint,
} from "@shared/sim";
import type { MatchState, PlayerState } from "./MatchState.js";
import { SS_HITS_TO_ARM, WIND_MIN, WIND_MAX } from "./MatchState.js";
import { expandFork, TROJAN } from "./loadout.js";
import type { ShotResult } from "./shotResult.js";

/**
 * THE SINGLE MANDATORY SEAM (ROADMAP success criterion 5) — Phase 2, plan 02.
 *
 * The only outcome-producing code path. Owns all local match state and the
 * frozen-sim calls; everything Phaser/animation routes through it. It is
 * Phaser-free (the ESLint guard on src/match/** enforces this) and fully
 * headless-testable.
 *
 * PHASE 3 SWAP POINT: `applyShot` is the ONLY method whose body changes in
 * Phase 3 — local `resolveShot` becomes a server `shotResult` broadcast/listen.
 * The return shape ({@link ShotResult}) and every call site (the Scene calling
 * `applyShot` / `previewTrajectory` / `advanceTurn`) stay identical.
 */
export class MatchController {
  constructor(
    private readonly terrain: TerrainMask,
    readonly state: MatchState,
  ) {}

  /**
   * Cosmetic aim preview (PLAY-02). Delegates to the frozen ballistics
   * integrator and returns just the path. Phase 3 keeps this IDENTICAL —
   * trajectory preview is purely client-side.
   */
  previewTrajectory(aim: ShotInput): TrajectoryPoint[] {
    return simulateTrajectory(aim, this.terrain).path;
  }

  /**
   * Resolve a fired shot into a {@link ShotResult} AND apply its effects.
   *
   * THE SWAP POINT. Forks the aim client-side (research A1), animates the first
   * sub-shot's arc as the visible primary, resolves every sub-shot against the
   * shared mask, sums damage per-mech (mirrors the sim's sumPerMech so
   * multi-carve damage combines rather than overwrites), mutates mech HP, ticks
   * the SS hit-charge, and accumulates the def's turnDelay onto the active
   * player. In Phase 3 the body is replaced by a server round-trip; the
   * signature and return shape do not change.
   */
  applyShot(aim: ShotInput, def: ProjectileDef): ShotResult {
    const subShots = expandFork(aim, def);

    // The visible primary arc = the first sub-shot's flight.
    const primary = simulateTrajectory(subShots[0], this.terrain);

    const carves: Carve[] = [];
    const damageTotals = new Map<string, number>();

    for (const sub of subShots) {
      const { carves: subCarves, damage: subDamage } = resolveShot(
        sub,
        this.terrain,
        this.state.mechs,
        sub.projectile,
      );
      carves.push(...subCarves);
      for (const d of subDamage) {
        damageTotals.set(d.mechId, (damageTotals.get(d.mechId) ?? 0) + d.amount);
      }
    }

    const damage: Damage[] = [...damageTotals].map(([mechId, amount]) => ({
      mechId,
      amount,
    }));

    // Apply HP loss (PLAY-08), clamped at 0.
    for (const d of damage) {
      const mech = this.state.mechs.find((m) => m.id === d.mechId);
      if (mech) mech.hp = Math.max(0, mech.hp - d.amount);
    }

    const active = this.activePlayer();

    // SS hit-charge: any damage landed counts as one hit (capped at the arm
    // threshold). Firing the Trojan consumes the charge.
    if (damage.length > 0) {
      active.ssHitCharge = Math.min(SS_HITS_TO_ARM, active.ssHitCharge + 1);
    }
    if (def.id === TROJAN.id) {
      active.ssHitCharge = 0;
    }

    // Delay queue (PLAY-06): firing accumulates the def's tempo cost.
    active.accumulatedDelay += def.turnDelay;

    return {
      path: primary.path,
      impact: primary.impact,
      carves,
      damage,
    };
  }

  /**
   * Advance the delay queue (PLAY-06): the player with the LOWEST accumulated
   * delay acts next. Ties break deterministically by player order. Because a
   * low-delay player's accumulator stays low, they can become active again
   * immediately after a high-delay opponent's turn.
   */
  advanceTurn(): void {
    let next = this.state.players[0];
    for (const p of this.state.players) {
      if (p.accumulatedDelay < next.accumulatedDelay) next = p;
    }
    this.state.activePlayerId = next.id;
  }

  /**
   * Roll wind into [WIND_MIN, WIND_MAX] (PLAY-02 input). Cadence is roll at the
   * start of each turn (Claude's discretion). RNG is injected (default
   * Math.random) so tests can seed it deterministically.
   */
  rollWind(rng: () => number = Math.random): void {
    this.state.wind = WIND_MIN + rng() * (WIND_MAX - WIND_MIN);
  }

  /** True once the player has landed enough hits to arm the Trojan. */
  isSSArmed(playerId: string): boolean {
    const p = this.state.players.find((pl) => pl.id === playerId);
    return p ? p.ssHitCharge >= SS_HITS_TO_ARM : false;
  }

  /**
   * Last-mech-standing win check (PLAY-07): if exactly one mech has hp > 0,
   * return its id; otherwise null (game continues or is a draw/empty).
   */
  checkWin(): string | null {
    const alive = this.state.mechs.filter((m) => m.hp > 0);
    return alive.length === 1 ? alive[0].id : null;
  }

  private activePlayer(): PlayerState {
    const p = this.state.players.find(
      (pl) => pl.id === this.state.activePlayerId,
    );
    if (!p) throw new Error(`active player ${this.state.activePlayerId} not found`);
    return p;
  }
}
