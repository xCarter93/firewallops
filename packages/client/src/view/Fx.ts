import Phaser from "phaser";
import type { Damage } from "@shared/sim";

/**
 * Impact juice (Phase 2, plan 04) — UI-SPEC "moderate" FX, criterion 4.
 *
 * Three effects fired at impact, all driven by data from the resolved
 * `ShotResult` (blast radius + per-mech damage). Pure consumer: imports the
 * `Damage` data type only — no sim outcome function (ESLint seam guard on
 * view/**).
 *
 *   - explode(point, blastRadius): an expanding ring + threat-red `#EF4444`
 *     core flash that fades over 200-300ms, scaled by blastRadius. Tweens
 *     radius/alpha on Arc graphics — never a layout-shifting scale transform.
 *   - shake(durationMs, intensity): wraps the main camera shake, clamped <=300ms
 *     (UI-SPEC). A reduced-motion factor dampens amplitude.
 *   - floatDamage(damage, lookup): a red Share Tech Mono number per damaged
 *     mech, rising 32px (one `xl`) and fading over ~600ms; bigger font for
 *     larger amounts so direct hits read bigger.
 */
export class Fx {
  private static readonly THREAT = 0xef4444;
  private static readonly MAX_SHAKE_MS = 300;
  /** Reduced-motion dampening factor for shake amplitude (v0 constant). */
  private readonly motionFactor: number;

  constructor(private readonly scene: Phaser.Scene) {
    // Respect a reduced-motion intent where feasible (UI-SPEC).
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.motionFactor = reduce ? 0.35 : 1;
  }

  /**
   * Expanding ring + red core flash at the impact point, scaled by blastRadius.
   * Fades over ~200-300ms. Radius/alpha are tweened (no layout-shifting scale).
   */
  explode(point: { x: number; y: number }, blastRadius: number): void {
    const dur = 260;

    // Red core flash: a filled disc that briefly blooms then fades.
    const core = this.scene.add
      .circle(point.x, point.y, blastRadius * 0.5, Fx.THREAT, 0.9)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({
      targets: core,
      radius: blastRadius * 0.9,
      alpha: 0,
      duration: dur,
      ease: "Quad.easeOut",
      onComplete: () => core.destroy(),
    });

    // Expanding ring: a stroked circle that grows past the blast and fades.
    const ring = this.scene.add.circle(point.x, point.y, blastRadius * 0.3);
    ring.setStrokeStyle(3, Fx.THREAT, 1);
    ring.setFillStyle();
    this.scene.tweens.add({
      targets: ring,
      radius: blastRadius * 1.3,
      alpha: 0,
      duration: dur,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  /** Camera shake, clamped <=300ms; intensity dampened by the motion factor. */
  shake(durationMs: number, intensity: number): void {
    const dur = Phaser.Math.Clamp(durationMs, 0, Fx.MAX_SHAKE_MS);
    if (dur <= 0 || intensity <= 0) return;
    this.scene.cameras.main.shake(dur, intensity * this.motionFactor);
  }

  /**
   * Spawn a rising red damage number per damaged mech. `lookup` maps a mechId
   * to its current world position. Larger amounts render bigger (direct hits
   * read bigger — Phase 1 lethality anchors). Each number rises 32px and fades
   * over ~600ms, then destroys itself.
   */
  floatDamage(
    damage: Damage[],
    lookup: (mechId: string) => { x: number; y: number } | null,
  ): void {
    for (const d of damage) {
      if (d.amount <= 0) continue;
      const at = lookup(d.mechId);
      if (!at) continue;

      // Bigger font for heavier hits: 18px graze -> ~34px dead-center.
      const size = Phaser.Math.Clamp(16 + d.amount * 0.36, 18, 34);
      const label = this.scene.add
        .text(at.x, at.y - 10, `-${Math.round(d.amount)}`, {
          fontFamily: "'Share Tech Mono'",
          fontSize: `${Math.round(size)}px`,
          color: "#EF4444",
        })
        .setOrigin(0.5, 1);

      this.scene.tweens.add({
        targets: label,
        y: label.y - 32,
        alpha: 0,
        duration: 600,
        ease: "Quad.easeOut",
        onComplete: () => label.destroy(),
      });
    }
  }
}
