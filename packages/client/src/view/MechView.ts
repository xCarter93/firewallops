import Phaser from "phaser";
import { muzzleOffset } from "@shared/sim";
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
// --- Floating-above-mech HP widget (Phase 02.1, plan 03 — UI-SPEC) ---
const HP_BAR_W = 64; // floating bar width (UI-SPEC: 64x8 above a 28px mech)
const HP_BAR_H = 8;
const HP_ANCHOR_OFFSET = 18; // body top edge − 18px, clear of cyan outline + barrel
const HP_CRITICAL_FRAC = 0.25; // forced critical-red below 25% (Phase 2 parity)
const HP_GREEN = 0x22c55e;
const HP_RED = 0xef4444;
const HP_SURFACE = 0x334155;
const HP_TEXT = "#F8FAFC";
const HP_TEXT_CRITICAL = "#EF4444";

// --- Team body colors (Phase 3, 2-team model). Team 0 = A, team 1 = B. The
// default chassis color (0x1e293b) is kept for the hotseat path; networked
// mechs are tinted by team so opponents are distinguishable at a glance. ---
const TEAM_DEFAULT = 0x1e293b;
const TEAM_A = 0x2563eb; // blue-600 — Team A
const TEAM_B = 0xdc2626; // red-600 — Team B

export class MechView {
  private readonly body: Phaser.GameObjects.Rectangle;
  private readonly barrel: Phaser.GameObjects.Line;
  private static readonly BARREL_LEN = 22;

  // Floating HP widget — WORLD-space (NOT scroll-locked): it tracks the mech as
  // the camera pans the larger world. Scroll-locking it would detach it from the
  // mech (RESEARCH anti-pattern, threat T-02.1-08).
  private readonly hpBar: Phaser.GameObjects.Graphics;
  private readonly hpNum: Phaser.GameObjects.Text;
  private hp = 100;

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

    // Floating HP bar + number. Deliberately left UNLOCKED to the camera (no
    // scroll-factor zeroing) — these are world-space objects anchored above the
    // mech, so they scroll with the camera (threat T-02.1-08).
    this.hpBar = scene.add.graphics();
    this.hpNum = scene.add
      .text(x, y, "100", {
        fontFamily: "'Share Tech Mono'",
        fontSize: "16px",
        color: HP_TEXT,
      })
      .setOrigin(0.5, 1);

    // Draw once so the widget shows at match start (defaults to 100).
    this.setHp(100);
  }

  /**
   * Redraw the floating HP bar + number for the given HP, anchored above the
   * current body position (single source of anchor math via updateHpLayout).
   * 64x8 bar at body-top − 18px in WORLD coords; green→red lerp forced to
   * critical-red below 25%; number always shown (color is not the only signal).
   */
  setHp(hp: number): void {
    this.hp = hp;
    this.updateHpLayout();
  }

  /**
   * SINGLE shared anchor helper read by BOTH setHp and setPosition so the bar +
   * number always agree on placement (no duplicated / stale anchor math). Reads
   * the CURRENT body position so a settle-tween that moves the body re-anchors
   * the widget correctly.
   *
   * COORDINATE NOTE (RESEARCH anti-pattern — do NOT double-negate): the sim
   * encodes y-down already; the widget sits above the mech via a SINGLE
   * subtraction (`y - MECH_BODY_H / 2 - 18`). No second negation.
   */
  private updateHpLayout(): void {
    const x = this.body.x;
    const y = this.body.y;
    const barLeft = x - HP_BAR_W / 2; // centered on the 64px width over the mech
    const barTop = y - MECH_BODY_H / 2 - HP_ANCHOR_OFFSET;

    const frac = Phaser.Math.Clamp(this.hp / 100, 0, 1);
    const critical = frac < HP_CRITICAL_FRAC;
    const fillInt = critical ? HP_RED : MechView.lerpHpColor(frac);

    const g = this.hpBar;
    g.clear();
    g.fillStyle(HP_SURFACE, 1);
    g.fillRect(barLeft, barTop, HP_BAR_W, HP_BAR_H);
    g.fillStyle(fillInt, 1);
    g.fillRect(barLeft, barTop, HP_BAR_W * frac, HP_BAR_H);

    // Number centered above the bar — ALWAYS rendered (a11y), critical-red <25%.
    this.hpNum.setPosition(x, barTop - 2);
    this.hpNum.setText(`${Math.max(0, Math.round(this.hp))}`);
    this.hpNum.setColor(critical ? HP_TEXT_CRITICAL : HP_TEXT);
  }

  // Pre-built endpoint Colors for the HP lerp (HP_RED(0) → HP_GREEN(1)).
  private static readonly HP_RED_COLOR = Phaser.Display.Color.IntegerToColor(HP_RED);
  private static readonly HP_GREEN_COLOR = Phaser.Display.Color.IntegerToColor(HP_GREEN);

  /** HP_RED(0)->HP_GREEN(1) lerp returning a packed 0xRRGGBB int (Phaser color API). */
  private static lerpHpColor(frac: number): number {
    const t = Phaser.Math.Clamp(frac, 0, 1);
    const c = Phaser.Display.Color.Interpolate.ColorWithColor(
      MechView.HP_RED_COLOR,
      MechView.HP_GREEN_COLOR,
      100,
      t * 100,
    );
    return Phaser.Display.Color.GetColor(c.r, c.g, c.b);
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

  /**
   * Tint the chassis by team (Phase 3, 2-team model): team 0 = Team A (blue),
   * team 1 = Team B (red). Any other value falls back to the default chassis
   * color. Color is a secondary cue only — the cyan active outline + barrel +
   * HP widget remain the primary signals (no color-only state).
   */
  setTeamColor(team: number): void {
    const color = team === 0 ? TEAM_A : team === 1 ? TEAM_B : TEAM_DEFAULT;
    this.body.setFillStyle(color);
  }

  /** Toggle the cyan "you control this" outline (UI-SPEC reserved cyan #1). */
  setActive(active: boolean): void {
    if (active) {
      this.body.setStrokeStyle(2, 0x22d3ee);
    } else {
      this.body.setStrokeStyle();
    }
  }

  /** Move the whole mech (body + barrel pivot + floating HP) — used when walking. */
  setPosition(x: number, y: number): void {
    this.body.setPosition(x, y);
    this.barrel.setPosition(x, y);
    // Re-anchor the floating HP via the SAME helper so it tracks the mech (walk
    // + settle-tween) and never agrees-by-accident with setHp.
    this.updateHpLayout();
  }

  /** Tear down all graphics (used on rematch rebuild). */
  destroy(): void {
    this.body.destroy();
    this.barrel.destroy();
    this.hpBar.destroy();
    this.hpNum.destroy();
  }

  get x(): number {
    return this.body.x;
  }

  get y(): number {
    return this.body.y;
  }

  /**
   * The barrel tip in world space, for the launch indicator + projectile
   * spawn. Delegates to the shared `muzzleOffset` (Phase 3, Agreed Concern #1):
   * the server authority (Plan 03) derives the launch point from the SAME
   * helper, so this cosmetic preview tip and the real shot cannot drift.
   *
   * `this.barrel.rotation` is already `-DegToRad(absoluteAngleDeg)`, so feeding
   * back the absolute degrees (`-rotation * 180 / Math.PI`) reproduces the
   * identical tip the shared helper computes.
   */
  getMuzzle(): { x: number; y: number } {
    const absoluteAngleDeg = (-this.barrel.rotation * 180) / Math.PI;
    return muzzleOffset(this.body.x, this.body.y, absoluteAngleDeg);
  }
}
