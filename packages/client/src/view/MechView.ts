import Phaser from "phaser";
import { MECH_BODY_W, MECH_BODY_H } from "../world.js";

/**
 * Geometric placeholder mech (Phase 2, plan 03) — real art is Phase 6/UI-05.
 *
 * A body rectangle (`#1E293B`) plus a code-rotated barrel line (`#F8FAFC`).
 * The ACTIVE mech (whose turn it is) gets a cyan outline — UI-SPEC reserved
 * cyan use #1: "this is the thing you're currently controlling." That cyan is
 * paired with a position/label cue elsewhere so color is not the only signal.
 *
 * COORDINATE NOTE (RESEARCH anti-pattern — do NOT double-negate): the sim
 * already encodes y-down (angle 0=right, 90=up; it negates sin internally).
 * So "up = negative rotation" is the SINGLE negation: `DegToRad(-angleDeg)`.
 *
 * FACING (02-04 NO-GO fix 2): `setBarrelAngle` now takes the ABSOLUTE sim angle
 * (0=right…90=up…180=left), so the same negate-for-y-down rule covers the full
 * range and the barrel points the way the shot will actually fly. `setFacing`
 * flips only the CHASSIS body (`setScale(facing,1)`) for the visual orientation
 * cue; the barrel direction is owned entirely by the absolute angle (flipping
 * the barrel too would double-mirror it).
 */
export class MechView {
  private readonly body: Phaser.GameObjects.Rectangle;
  private readonly barrel: Phaser.GameObjects.Line;
  private static readonly BARREL_LEN = 22;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
  ) {
    this.body = scene.add.rectangle(x, y, MECH_BODY_W, MECH_BODY_H, 0x1e293b);

    // Barrel pivots at the body center; origin (0, 0.5) so it rotates about its
    // base. Drawn pointing right at angle 0.
    this.barrel = scene.add
      .line(x, y, 0, 0, MechView.BARREL_LEN, 0, 0xf8fafc)
      .setOrigin(0, 0.5);
  }

  /**
   * Rotate the barrel to the ABSOLUTE sim angle (0=right…90=up…180=left). The
   * single y-down negation covers the whole 0–180 range, so a facing-left shot
   * (e.g. absolute 150°) points the barrel up-and-left, matching the arc.
   */
  setBarrelAngle(absoluteAngleDeg: number): void {
    this.barrel.setRotation(Phaser.Math.DegToRad(-absoluteAngleDeg));
  }

  /** Flip the chassis to face left (-1) or right (+1) — visual cue only. */
  setFacing(facing: 1 | -1): void {
    this.body.setScale(facing, 1);
  }

  /** Toggle the cyan "you control this" outline (UI-SPEC reserved cyan #1). */
  setActive(active: boolean): void {
    if (active) {
      this.body.setStrokeStyle(2, 0x22d3ee);
    } else {
      this.body.setStrokeStyle();
    }
  }

  /** Move the whole mech (body + barrel pivot) — used when walking. */
  setPosition(x: number, y: number): void {
    this.body.setPosition(x, y);
    this.barrel.setPosition(x, y);
  }

  /** Tear down both graphics (used on rematch rebuild). */
  destroy(): void {
    this.body.destroy();
    this.barrel.destroy();
  }

  get x(): number {
    return this.body.x;
  }

  get y(): number {
    return this.body.y;
  }

  /**
   * The barrel tip in world space, for the launch indicator + projectile
   * spawn. Uses the SAME single-negation y-down convention as the sim muzzle
   * math so the cosmetic indicator and the real shot agree.
   */
  getMuzzle(): { x: number; y: number } {
    const a = this.barrel.rotation; // already -DegToRad(angleDeg)
    return {
      x: this.body.x + Math.cos(a) * MechView.BARREL_LEN,
      y: this.body.y + Math.sin(a) * MechView.BARREL_LEN,
    };
  }
}
