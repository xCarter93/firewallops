import type { ShotResult } from "../match/shotResult.js";

/**
 * Shot-result bridge (Phase 3, plan 04) — NET-01.
 *
 * THE SINGLE MUTATION SOURCE. HP and terrain change ONLY when a server
 * `shotResult` arrives here and is forwarded to the scene's animation path —
 * never at fire time. The bridge is deliberately Phaser-free: Phaser stays in
 * the scene (which implements ShotAnimationSink); the bridge just forwards.
 *
 * This keeps the net layer (room.ts) decoupled from the scene's concrete type —
 * the scene registers itself as the sink and the bridge routes each broadcast
 * shot into `sink.animateShot(result)`.
 */

/** The contract the scene implements: animate (and reconcile) a resolved shot. */
export interface ShotAnimationSink {
  animateShot(result: ShotResult): void;
}

/**
 * Holds the sink and forwards each shotResult to it. The scene constructs this
 * with itself as the sink and passes `bridge.onShotResult` as the net layer's
 * `onShotResult` handler — so a server broadcast flows
 * room.onMessage("shotResult") → bridge → scene.animateShot, the one and only
 * place HP/terrain mutate.
 */
export class ShotResultBridge {
  constructor(private readonly sink: ShotAnimationSink) {}

  /**
   * The single mutation entry point. Forwards the authoritative shot outcome to
   * the scene's animation path. Bound so it can be passed as a bare callback.
   */
  onShotResult = (result: ShotResult): void => {
    this.sink.animateShot(result);
  };
}
