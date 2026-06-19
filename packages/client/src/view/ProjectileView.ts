import Phaser from "phaser";
import type { TrajectoryPoint } from "@shared/sim";

/**
 * Glowing-dot projectile (Phase 2, plan 04) — PLAY-03.
 *
 * Animates a cyan dot (cyber-cyan core `#22D3EE` + soft additive glow, UI-SPEC)
 * along the `shotResult.path` produced by `MatchController.applyShot`. It is a
 * PURE CONSUMER of the resolved path — it imports no sim outcome function
 * (ESLint seam guard on view/**); the `TrajectoryPoint` type import is allowed.
 *
 * It steps an index through the path points at a fixed points-per-ms cadence so
 * the flight feels weighty (~600-1200ms total; each segment well under 500ms),
 * then invokes `onImpact` once at the path end and cleans itself up.
 */
export class ProjectileView {
  private static readonly CORE = 0x22d3ee;
  /** Path samples advanced per millisecond (tuned for ~600-1200ms flights). */
  private static readonly PTS_PER_MS = 0.06;
  /** Clamp the total flight so very long arcs still resolve promptly. */
  private static readonly MIN_FLIGHT_MS = 600;
  private static readonly MAX_FLIGHT_MS = 1200;

  private readonly core: Phaser.GameObjects.Arc;
  private readonly glow: Phaser.GameObjects.Arc;

  constructor(private readonly scene: Phaser.Scene) {
    // Soft additive glow underneath, brighter solid core on top.
    this.glow = scene.add
      .circle(0, 0, 9, ProjectileView.CORE, 0.35)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setVisible(false);
    this.core = scene.add
      .circle(0, 0, 3.5, ProjectileView.CORE, 1)
      .setVisible(false);
  }

  /** The live dot (so the follow-cam can target it). */
  get sprite(): Phaser.GameObjects.Arc {
    return this.core;
  }

  /**
   * Drive the dot along `path`, calling `onImpact` once at the end. The flight
   * duration scales with the path length but is clamped to the UI-SPEC timing
   * band. Owns its own cleanup: both graphics are destroyed on impact.
   */
  animateAlong(path: TrajectoryPoint[], onImpact: () => void): void {
    if (path.length === 0) {
      this.destroy();
      onImpact();
      return;
    }

    const start = path[0];
    this.place(start.x, start.y);
    this.core.setVisible(true);
    this.glow.setVisible(true);

    const flightMs = Phaser.Math.Clamp(
      path.length / ProjectileView.PTS_PER_MS,
      ProjectileView.MIN_FLIGHT_MS,
      ProjectileView.MAX_FLIGHT_MS,
    );

    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: flightMs,
      ease: "Linear",
      onUpdate: (tween) => {
        const idx = Math.min(
          path.length - 1,
          Math.floor((tween.getValue() ?? 0) * (path.length - 1)),
        );
        this.place(path[idx].x, path[idx].y);
      },
      onComplete: () => {
        const end = path[path.length - 1];
        this.place(end.x, end.y);
        this.destroy();
        onImpact();
      },
    });
  }

  private place(x: number, y: number): void {
    this.core.setPosition(x, y);
    this.glow.setPosition(x, y);
  }

  /** No post-impact tracer (CONTEXT) — tear both graphics down. */
  destroy(): void {
    this.core.destroy();
    this.glow.destroy();
  }
}
