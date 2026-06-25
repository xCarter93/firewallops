import Phaser from "phaser";
import { muzzleOffset } from "@shared/sim";
import { MECH_BODY_W, MECH_BODY_H } from "../world.js";
import { lerpAngleDeg, shortestAngleDeltaDeg, smoothingFactor } from "./angleInterp.js";

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

// --- CF-1 peer-disconnect visual (Phase 6 / UI-SPEC). A disconnected mobile is
// alpha-dimmed (mirrors room.ts's 0.5 opacity) and gets a RECONNECTING badge so
// color is NEVER the only signal: the dim is paired with a readable label. ---
const DISCONNECTED_ALPHA = 0.5; // mech body + barrel dim while reconnecting
const BADGE_BG = 0x141e33; // slate surface (var(--surface)-equivalent)
const BADGE_BORDER = 0x22d3ee; // cyan border (reserved status accent)
const BADGE_TEXT = "RECONNECTING…"; // vector label, no emoji (repo no-emoji rule)
const BADGE_PAD_X = 8; // horizontal text inset inside the badge rect
const BADGE_PAD_Y = 4; // vertical text inset inside the badge rect
const BADGE_GAP = 6; // gap above the floating HP number

// --- Opponent-barrel ENTITY INTERPOLATION (smoothness). Synced state lands at
// ~20Hz; the spectator barrel lerps toward the latest synced angle each frame
// instead of snapping (see angleInterp.ts). TAU is the smoothing time constant;
// a delta larger than SNAP_DEG is treated as a teleport (spawn / facing flip)
// and applied instantly so the barrel never sweeps the long way through the
// floor. The LOCAL player's own barrel is NOT interpolated — it is driven
// immediately from local input (setBarrelAngle), so input stays responsive. ---
const BARREL_TAU_MS = 70;
const BARREL_SNAP_DEG = 60;

export class MechView {
  private readonly body: Phaser.GameObjects.Rectangle;
  private readonly barrel: Phaser.GameObjects.Line;
  private static readonly BARREL_LEN = 22;

  // Interpolation state for the spectator barrel. `current` is what is rendered;
  // `target` is the latest synced angle. Defaults to the schema default (45) so a
  // fresh view starts level. setBarrelAngle snaps both (immediate); the opponent
  // path sets only `target` and interpolateBarrel() walks `current` toward it.
  private currentBarrelDeg = 45;
  private targetBarrelDeg = 45;

  // Floating HP widget — WORLD-space (NOT scroll-locked): it tracks the mech as
  // the camera pans the larger world. Scroll-locking it would detach it from the
  // mech (RESEARCH anti-pattern, threat T-02.1-08).
  private readonly hpBar: Phaser.GameObjects.Graphics;
  private readonly hpNum: Phaser.GameObjects.Text;
  private hp = 100;

  // CF-1 RECONNECTING badge — a slate-bg rect + cyan border + label, anchored
  // above the HP number in WORLD space (same as the HP widget, so it tracks the
  // mech when the camera pans). Built once, hidden until a disconnect; its
  // position is recomputed in the SHARED updateHpLayout helper so it never drifts
  // after settle/movement (review concern 8). `disconnected` gates show/position.
  private readonly badgeBg: Phaser.GameObjects.Graphics;
  private readonly badgeText: Phaser.GameObjects.Text;
  private disconnected = false;

  // Set in destroy() so a LATE caller that touches this view after its Phaser
  // objects are gone is a safe no-op instead of a "Cannot read properties of null
  // (reading 'drawImage')" throw. Three races reach a destroyed view: a running
  // settle-tween whose onUpdate closure still holds the view (applySettleFromState),
  // an M6 stale-view removal that drops the view while a patch is mid-flight, and a
  // reconnect remount. Mirrors the scene-level `disposed` guard, one level down.
  private destroyed = false;

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

    // CF-1 RECONNECTING badge (hidden until a disconnect). Like the HP widget it
    // is WORLD-space (NOT scroll-locked) so it tracks the mech as the camera pans.
    // The bg rect is drawn in updateHpLayout once the label size is known.
    this.badgeBg = scene.add.graphics().setVisible(false);
    this.badgeText = scene.add
      .text(x, y, BADGE_TEXT, {
        fontFamily: "'Fira Code'",
        fontSize: "11px",
        color: "#22D3EE",
      })
      .setOrigin(0.5, 1)
      .setVisible(false);

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
    if (this.destroyed) return;
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
    if (this.destroyed) return;
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
    const numTop = barTop - 2;
    this.hpNum.setPosition(x, numTop);
    this.hpNum.setText(`${Math.max(0, Math.round(this.hp))}`);
    this.hpNum.setColor(critical ? HP_TEXT_CRITICAL : HP_TEXT);

    // CF-1: re-anchor the RECONNECTING badge above the HP number EVERY layout
    // pass (review concern 8) so it tracks the mech after settle/movement, not
    // only when setConnected() fires. The badge font is ~14px tall, so the HP
    // number top minus the badge height clears it.
    this.layoutBadge(x, numTop - this.hpNum.height - BADGE_GAP);
  }

  /**
   * Position + (re)draw the RECONNECTING badge so it sits centered at (cx, cy),
   * anchored just above the HP number. Only renders when `disconnected` is true;
   * otherwise it is left hidden. Called from the shared updateHpLayout helper so
   * the badge re-anchors on every body/HP-bar move (settle, walk, snap).
   */
  private layoutBadge(cx: number, cy: number): void {
    if (!this.disconnected) return;
    // Anchor the text bottom at cy; bg rect wraps it with padding.
    this.badgeText.setPosition(cx, cy);
    const tw = this.badgeText.width;
    const th = this.badgeText.height;
    const rectW = tw + BADGE_PAD_X * 2;
    const rectH = th + BADGE_PAD_Y * 2;
    const rectLeft = cx - rectW / 2;
    const rectTop = cy - th - BADGE_PAD_Y; // text bottom sits at cy

    const g = this.badgeBg;
    g.clear();
    g.fillStyle(BADGE_BG, 0.92);
    g.fillRect(rectLeft, rectTop, rectW, rectH);
    g.lineStyle(2, BADGE_BORDER, 1);
    g.strokeRect(rectLeft, rectTop, rectW, rectH);
  }

  /**
   * CF-1: reflect the synced `connected` state on the canvas. A disconnected
   * mobile is alpha-dimmed (mirrors room.ts's 0.5 opacity) and shows the
   * RECONNECTING badge; a reconnected one restores full alpha and hides the
   * badge. The dim is paired with the readable label so color is never the only
   * signal. The badge's POSITION is owned by the shared updateHpLayout helper
   * (re-anchored on every move); this only toggles visibility/alpha and triggers
   * one immediate re-layout so it appears in the right place at once.
   */
  setConnected(connected: boolean): void {
    if (this.destroyed) return;
    this.disconnected = !connected;
    const alpha = connected ? 1 : DISCONNECTED_ALPHA;
    this.body.setAlpha(alpha);
    this.barrel.setAlpha(alpha);
    this.badgeBg.setVisible(this.disconnected);
    this.badgeText.setVisible(this.disconnected);
    // Re-anchor immediately so the badge is placed correctly the moment it shows
    // (subsequent moves re-anchor it automatically via updateHpLayout).
    this.updateHpLayout();
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
   * Rotate the barrel to the ABSOLUTE sim angle (0=right…90=up…180=left),
   * IMMEDIATELY (no interpolation). The single y-down negation covers the whole
   * 0–180 range, so a facing-left shot (e.g. absolute 150°) points the barrel
   * up-and-left, matching the arc.
   *
   * Used for the LOCAL player's own barrel (driven from local input — must be
   * instant) and to snap a view to its initial angle. It also resets the
   * interpolation buffers so a later switch to the interpolated path starts from
   * the rendered angle (no sweep).
   */
  setBarrelAngle(absoluteAngleDeg: number): void {
    if (this.destroyed) return;
    this.currentBarrelDeg = absoluteAngleDeg;
    this.targetBarrelDeg = absoluteAngleDeg;
    this.barrel.setRotation(Phaser.Math.DegToRad(-absoluteAngleDeg));
  }

  /**
   * Set the TARGET barrel angle for a spectated (non-local) mech without moving
   * the barrel this instant — interpolateBarrel() walks the rendered angle toward
   * it each frame (entity interpolation against the ~20Hz state stream).
   */
  setBarrelAngleTarget(absoluteAngleDeg: number): void {
    if (this.destroyed) return;
    this.targetBarrelDeg = absoluteAngleDeg;
  }

  /**
   * Advance the spectator barrel one frame toward its target angle. Called per
   * Phaser frame for NON-local mechs (MatchScene.updateNetworked). A large
   * remaining delta (> BARREL_SNAP_DEG) is a teleport — spawn or facing flip —
   * and is applied instantly so the barrel never sweeps through the floor; a
   * small delta is eased with a frame-rate-independent factor.
   */
  interpolateBarrel(dtMs: number): void {
    if (this.destroyed) return;
    const delta = shortestAngleDeltaDeg(this.currentBarrelDeg, this.targetBarrelDeg);
    if (Math.abs(delta) > BARREL_SNAP_DEG) {
      this.currentBarrelDeg = this.targetBarrelDeg;
    } else {
      this.currentBarrelDeg = lerpAngleDeg(
        this.currentBarrelDeg,
        this.targetBarrelDeg,
        smoothingFactor(dtMs, BARREL_TAU_MS),
      );
    }
    this.barrel.setRotation(Phaser.Math.DegToRad(-this.currentBarrelDeg));
  }

  /** Flip the chassis to face left (-1) or right (+1) — visual cue only. */
  setFacing(facing: 1 | -1): void {
    if (this.destroyed) return;
    this.body.setScale(facing, 1);
  }

  /**
   * Tint the chassis by team (Phase 3, 2-team model): team 0 = Team A (blue),
   * team 1 = Team B (red). Any other value falls back to the default chassis
   * color. Color is a secondary cue only — the cyan active outline + barrel +
   * HP widget remain the primary signals (no color-only state).
   */
  setTeamColor(team: number): void {
    if (this.destroyed) return;
    const color = team === 0 ? TEAM_A : team === 1 ? TEAM_B : TEAM_DEFAULT;
    this.body.setFillStyle(color);
  }

  /** Toggle the cyan "you control this" outline (UI-SPEC reserved cyan #1). */
  setActive(active: boolean): void {
    if (this.destroyed) return;
    if (active) {
      this.body.setStrokeStyle(2, 0x22d3ee);
    } else {
      this.body.setStrokeStyle();
    }
  }

  /** Move the whole mech (body + barrel pivot + floating HP) — used when walking. */
  setPosition(x: number, y: number): void {
    if (this.destroyed) return;
    this.body.setPosition(x, y);
    this.barrel.setPosition(x, y);
    // Re-anchor the floating HP via the SAME helper so it tracks the mech (walk
    // + settle-tween) and never agrees-by-accident with setHp.
    this.updateHpLayout();
  }

  /** Tear down all graphics (used on rematch rebuild). Idempotent + flips the
   * `destroyed` flag so any late mutator call is a safe no-op. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.body.destroy();
    this.barrel.destroy();
    this.hpBar.destroy();
    this.hpNum.destroy();
    this.badgeBg.destroy();
    this.badgeText.destroy();
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
