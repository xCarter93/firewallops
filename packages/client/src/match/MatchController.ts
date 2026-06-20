import { simulateTrajectory, TerrainMask } from "@shared/sim";
import type {
  ProjectileDef,
  ShotInput,
  TrajectoryPoint,
} from "@shared/sim";
import type { MatchState } from "./MatchState.js";
import { SS_HITS_TO_ARM, WIND_MIN, WIND_MAX } from "./MatchState.js";

/**
 * THE SINGLE MANDATORY SEAM (ROADMAP success criterion 5) — Phase 2, plan 02.
 *
 * Owns the local hotseat match state + the frozen-sim aim preview; everything
 * Phaser/animation routes through it. It is Phaser-free (the ESLint guard on
 * src/match/** enforces this) and net-free (it receives a plain sender
 * callback), so it stays fully headless-testable.
 *
 * PHASE 3: applyShot is now FIRE-AND-FORGET. It forwards the fired (aim, def) to
 * the injected network sender and returns void. The outcome — HP, terrain
 * carves, delay, SS-charge, turn advance, win — arrives later via the server
 * `shotResult` broadcast and the synced MatchState, applied by MatchScene's
 * broadcast/sync handlers. The local mutation that lived here is gone; the
 * server is the sole authority (NET-01). The seam is preserved: MatchScene still
 * calls controller.applyShot(); only its body and return type changed.
 *
 * advanceTurn / rollWind / checkWin / isSSArmed remain for type-compat and the
 * VITE_NETWORKED=off hotseat dev loop, but are SUPERSEDED by synced state in
 * networked play (the scene reads the broadcast MatchState instead of calling
 * them). They are intentionally not deleted.
 */
export class MatchController {
  /**
   * Injected network sender (Phase 3, Authority Decision 7). When set (networked
   * mode), `applyShot` forwards the fired shot to it instead of resolving
   * locally. Left undefined in the hotseat default — but in the hotseat path the
   * scene no longer relies on applyShot's old local resolution either; hotseat
   * keeps the Phase 2 controller behavior via the env-gated scene path.
   */
  private fireSender?: (aim: ShotInput, def: ProjectileDef) => void;

  constructor(
    private readonly terrain: TerrainMask,
    readonly state: MatchState,
  ) {}

  /**
   * Inject the network sender (the scene wires this to net `sendFire`). Keeping
   * the controller as the call site preserves the single seam: the scene still
   * calls `applyShot`, which fire-and-forgets through this callback.
   */
  setFireSender(fn: (aim: ShotInput, def: ProjectileDef) => void): void {
    this.fireSender = fn;
  }

  /**
   * Cosmetic aim preview (PLAY-02). Delegates to the frozen ballistics
   * integrator and returns just the path. Phase 3 keeps this IDENTICAL —
   * trajectory preview is purely client-side and is the ONLY remaining local-sim
   * call site.
   */
  previewTrajectory(aim: ShotInput): TrajectoryPoint[] {
    return simulateTrajectory(aim, this.terrain).path;
  }

  /**
   * FIRE-AND-FORGET (Phase 3 swap point). Forwards the fired (aim, def) to the
   * injected network sender and returns void. It NO LONGER runs the local sim
   * outcome resolver, mutates HP, carves the mask, ticks SS-charge, or
   * accumulates delay — those are SERVER-authoritative (Plan 03). The outcome
   * arrives later via the server `shotResult` broadcast + synced MatchState (NET-01).
   *
   * The seam is preserved: MatchScene still calls `controller.applyShot(aim, def)`;
   * only this body and the return type changed (Authority Decision 7 / Agreed
   * Concern #4 — the seam is NOT dead-ended into a direct scene→net call).
   */
  applyShot(aim: ShotInput, def: ProjectileDef): void {
    this.fireSender?.(aim, def);
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
}
