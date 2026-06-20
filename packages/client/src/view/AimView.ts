import Phaser from "phaser";
import { DEBUG_OVERLAY } from "../env.js";
import { buildShotInput } from "../match/aim.js";
import { LOADOUT } from "../match/loadout.js";
import type { ShotId } from "../match/loadout.js";
import type { MatchController } from "../match/MatchController.js";
import type { Mech } from "@shared/sim";

/**
 * Cosmetic aim preview (Phase 2, plan 03) — PLAY-02.
 *
 * Owns two render modes:
 *   1. Production launch indicator: a SHORT stubby cyan line from the muzzle.
 *      Length scales with power, with a slight wind-tilt hint. The full arc is
 *      deliberately HIDDEN in production — learning the arc is the skill.
 *   2. Dev-only full-arc overlay: a dotted previewTrajectory polyline + impact
 *      marker + Fira Code readouts. Gated behind DEBUG_OVERLAY (import.meta.env
 *      .DEV); the whole branch tree-shakes out of the prod bundle (Pattern 2,
 *      threat T-02-06). Toggled with backtick, ON by default in dev.
 *
 * Routes the arc through MatchController.previewTrajectory() — NEVER calls the
 * sim's simulateTrajectory directly (ESLint seam guard on view/**).
 */
export class AimView {
  private static readonly CYAN = 0x22d3ee;
  private static readonly WIND_TILT_K = 0.05;

  private readonly indicator: Phaser.GameObjects.Graphics;
  private readonly arc: Phaser.GameObjects.Graphics;
  private readonly readout: Phaser.GameObjects.Text;
  private showArc = true; // ON by default in dev (no-op when DEBUG_OVERLAY off)

  constructor(private readonly scene: Phaser.Scene) {
    this.indicator = scene.add.graphics();
    this.arc = scene.add.graphics();
    this.readout = scene.add
      .text(0, 0, "", {
        fontFamily: "'Fira Code'",
        fontSize: "12px",
        color: "#F8FAFC",
      })
      .setVisible(false);

    // Dev-only backtick toggle. In a production build DEBUG_OVERLAY is the
    // static literal `false`, so this whole block is dead-code-eliminated.
    if (DEBUG_OVERLAY) {
      const kb = scene.input.keyboard;
      if (kb) {
        const tick = kb.addKey(Phaser.Input.Keyboard.KeyCodes.BACKTICK);
        tick.on("down", () => {
          this.showArc = !this.showArc;
          if (!this.showArc) {
            this.arc.clear();
            this.readout.setVisible(false);
          }
        });
      }
    }
  }

  /**
   * Clear all aim overlays (Phase 3): the launch indicator + the dev arc +
   * readout. Used by the networked scene to wipe any local aim ghost when it is
   * NOT the local player's turn (opponents see barrel-angle only — no arc ghost).
   */
  clear(): void {
    this.indicator.clear();
    this.arc.clear();
    this.readout.setVisible(false);
  }

  /**
   * Production launch indicator (Pattern 4, PLAY-02). Stubby cyan line from the
   * muzzle; length grows with power; a small wind-tilt nudges the angle.
   *
   * Single-negate sin for y-down (coincides with the sim muzzle math, RESEARCH
   * coordinate note — do NOT double-negate).
   */
  drawLaunchIndicator(
    muzzle: { x: number; y: number },
    angleDeg: number,
    power: number,
    wind: number,
  ): void {
    const len = 20 + (power / 100) * 60;
    const tilt = wind * AimView.WIND_TILT_K;
    const a = Phaser.Math.DegToRad(angleDeg - tilt);

    this.indicator.clear();
    this.indicator.lineStyle(3, AimView.CYAN, 1);
    this.indicator.lineBetween(
      muzzle.x,
      muzzle.y,
      muzzle.x + Math.cos(a) * len,
      muzzle.y - Math.sin(a) * len,
    );
  }

  /**
   * Dev full-arc overlay (Pattern 2). Builds the live ShotInput for the
   * selected shot, asks the controller to preview the trajectory, and draws it
   * as a dotted polyline + impact marker + coord readout. Reflects the selected
   * shot (validates Shot 2 / Trojan forks too).
   *
   * No-op unless DEBUG_OVERLAY is set AND the overlay is toggled on. In prod the
   * DEBUG_OVERLAY guard removes this branch entirely.
   */
  drawDevArc(args: {
    controller: MatchController;
    mech: Mech;
    angleDeg: number;
    power: number;
    wind: number;
    gravity: number;
    selectedShotId: ShotId;
  }): void {
    if (!DEBUG_OVERLAY || !this.showArc) return;

    const aim = buildShotInput({
      mech: args.mech,
      angleDeg: args.angleDeg,
      power: args.power,
      wind: args.wind,
      gravity: args.gravity,
      def: LOADOUT[args.selectedShotId],
    });

    const path = args.controller.previewTrajectory(aim);

    this.arc.clear();
    this.arc.fillStyle(AimView.CYAN, 0.7);
    // Dotted polyline: stamp a small dot every few samples.
    for (let i = 0; i < path.length; i += 3) {
      this.arc.fillCircle(path[i].x, path[i].y, 1.5);
    }

    const last = path.length > 0 ? path[path.length - 1] : null;
    if (last) {
      // Impact marker.
      this.arc.lineStyle(1.5, AimView.CYAN, 1);
      this.arc.strokeCircle(last.x, last.y, 5);
      this.readout
        .setVisible(true)
        .setPosition(last.x + 8, last.y - 8)
        .setText(`impact (${last.x.toFixed(0)}, ${last.y.toFixed(0)})`);
    } else {
      this.readout.setVisible(false);
    }
  }
}
