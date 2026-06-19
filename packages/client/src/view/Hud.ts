import Phaser from "phaser";
import type { MatchController } from "../match/MatchController.js";
import type { MatchState } from "../match/MatchState.js";
import { SS_HITS_TO_ARM, MOVE_BUDGET_PER_TURN } from "../match/MatchState.js";
import type { ShotId } from "../match/loadout.js";

/**
 * Screen-space HUD overlay (Phase 2, plan 04) — PLAY-05/06/07/08.
 *
 * Hand-drawn Phaser `Graphics` / `Text` widgets per the Phase 2 UI-SPEC. Every
 * widget is scroll-locked (`setScrollFactor(0)`) so the HUD stays fixed while
 * the follow-cam scrolls the world. NO emoji glyphs — the wind arrow and charge
 * pips are drawn vector shapes (ui-ux-pro-max no-emoji rule). Color is never the
 * only signal: HP shows a number, the active player gets a label cue, and the
 * shot shows its name.
 *
 * Palette (UI-SPEC): field `#0F172A`, surface `#1E293B`/`#334155`, text
 * `#F8FAFC`, cyan `#22D3EE` (reserved: active cluster + NEXT marker), status
 * green `#22C55E`, threat red `#EF4444`. Typography: Share Tech Mono numerics
 * 24px, Fira Code labels 14px, Orbitron win banner 48px.
 *
 * Pure view: imports match TYPES + constants only, never a sim outcome function
 * (ESLint seam guard on view/**).
 */

const TEXT = "#F8FAFC";
const CYAN = 0x22d3ee;
const GREEN = 0x22c55e;
const RED = 0xef4444;
const SURFACE = 0x334155;

const HP_W = 120;
const HP_H = 12;
const MOVE_W = 120;
const MOVE_H = 8;
const PIP_R = 5;
const PIP_GAP = 4; // xs
const MARGIN = 24; // lg: HUD inset from screen edge
const CLUSTER_W = 160;

const LABEL_STYLE = {
  fontFamily: "'Fira Code'",
  fontSize: "14px",
  color: TEXT,
} as const;
const NUM_STYLE = {
  fontFamily: "'Share Tech Mono'",
  fontSize: "24px",
  color: TEXT,
} as const;

interface PlayerCluster {
  highlight: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  hpBar: Phaser.GameObjects.Graphics;
  hpNum: Phaser.GameObjects.Text;
  pips: Phaser.GameObjects.Graphics;
  trojan: Phaser.GameObjects.Text;
  moveBar: Phaser.GameObjects.Graphics;
  moveLabel: Phaser.GameObjects.Text;
  shot: Phaser.GameObjects.Text;
}

export class Hud {
  private readonly w: number;

  // Wind (top-center).
  private readonly windLabel: Phaser.GameObjects.Text;
  private readonly windArrow: Phaser.GameObjects.Graphics;
  private readonly windNum: Phaser.GameObjects.Text;

  // Turn / who's-next.
  private readonly nextLabel: Phaser.GameObjects.Text;

  private readonly clusters: Record<string, PlayerCluster> = {};

  // Pre-match onboarding hint (clears after the first shot).
  private readonly introHeading: Phaser.GameObjects.Text;
  private readonly introBody: Phaser.GameObjects.Text;
  private introVisible = true;

  // Transient near-mech flash (OUT OF MOVE BUDGET / BLOCKED).
  private readonly flashText: Phaser.GameObjects.Text;
  private flashTimer?: Phaser.Time.TimerEvent;

  // Win banner.
  private readonly banner: Phaser.GameObjects.Text;
  private readonly bannerSub: Phaser.GameObjects.Text;

  // Armed-pulse phase accumulator (color/opacity only, no layout scale).
  private pulseT = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    playerIds: string[],
  ) {
    const cam = scene.cameras.main;
    this.w = cam.width;

    // --- WIND (PLAY-05), top-center ---
    this.windLabel = this.lock(
      scene.add.text(this.w / 2, MARGIN, "WIND", LABEL_STYLE).setOrigin(0.5, 0),
    );
    this.windArrow = this.lock(scene.add.graphics());
    this.windNum = this.lock(
      scene.add
        .text(this.w / 2, MARGIN + 20, "0", NUM_STYLE)
        .setOrigin(0.5, 0),
    );

    // --- NEXT marker (delay queue, PLAY-06) ---
    this.nextLabel = this.lock(
      scene.add
        .text(this.w / 2, MARGIN + 50, "NEXT ▸ -", LABEL_STYLE)
        .setOrigin(0.5, 0),
    );

    // --- Per-player clusters: P1 left, P2 right (xl apart via screen edges) ---
    playerIds.forEach((id, i) => {
      const left = i === 0;
      const x = left ? MARGIN : this.w - MARGIN - CLUSTER_W;
      this.clusters[id] = this.buildCluster(id, x, left);
    });

    // --- Pre-match onboarding hint ---
    this.introHeading = this.lock(
      scene.add
        .text(this.w / 2, cam.height / 2 - 30, "FIREWALL OPS", {
          fontFamily: "'Orbitron'",
          fontSize: "32px",
          color: TEXT,
          fontStyle: "700",
        })
        .setOrigin(0.5),
    );
    this.introBody = this.lock(
      scene.add
        .text(
          this.w / 2,
          cam.height / 2 + 14,
          "P1 — set angle, power, fire.  ↑↓ aim · ←→ move · hold SPACE to charge.",
          LABEL_STYLE,
        )
        .setOrigin(0.5),
    );

    // --- Transient flash (positioned at a world point, so NOT scroll-locked) ---
    this.flashText = scene.add
      .text(0, 0, "", { ...LABEL_STYLE, color: "#EF4444" })
      .setOrigin(0.5, 1)
      .setVisible(false);

    // --- Win banner (hidden until a winner) ---
    this.banner = this.lock(
      scene.add
        .text(this.w / 2, cam.height / 2 - 48, "", {
          fontFamily: "'Orbitron'",
          fontSize: "48px",
          color: TEXT,
          fontStyle: "700",
        })
        .setOrigin(0.5)
        .setVisible(false),
    );
    this.bannerSub = this.lock(
      scene.add
        .text(this.w / 2, cam.height / 2 + 8, "R to rematch", LABEL_STYLE)
        .setOrigin(0.5)
        .setVisible(false),
    );
  }

  /** Build one player's HUD cluster anchored at screen X `x`. */
  private buildCluster(id: string, x: number, left: boolean): PlayerCluster {
    const s = this.scene;
    const label = id.toUpperCase();
    const top = MARGIN;

    const highlight = this.lock(
      s.add
        .rectangle(x - 6, top - 6, CLUSTER_W + 12, 96)
        .setOrigin(0, 0)
        .setFillStyle() // outline-only — clear the default black fill
        .setStrokeStyle(2, CYAN)
        .setVisible(false),
    );

    const labelText = this.lock(
      s.add.text(x, top, label, LABEL_STYLE).setOrigin(0, 0),
    );

    // "HP" field caption (UI-SPEC field label; color is not the only signal).
    this.lock(
      s.add
        .text(x + 40, top, "HP", { ...LABEL_STYLE, fontSize: "12px" })
        .setOrigin(0, 0),
    );

    const hpBar = this.lock(s.add.graphics());
    const hpNum = this.lock(
      s.add.text(x + HP_W + 8, top + 18, "100", NUM_STYLE).setOrigin(0, 0.5),
    );

    const pips = this.lock(s.add.graphics());

    const trojan = this.lock(
      s.add
        .text(x, top + 50, "TROJAN — LOCKED · LAND 3 HITS TO ARM", {
          ...LABEL_STYLE,
          fontSize: "12px",
        })
        .setOrigin(0, 0),
    );

    const moveLabel = this.lock(
      s.add.text(x, top + 68, "MOVE", LABEL_STYLE).setOrigin(0, 0),
    );
    const moveBar = this.lock(s.add.graphics());

    const shot = this.lock(
      s.add
        .text(left ? x + CLUSTER_W : x, top, "SHOT 1", {
          ...NUM_STYLE,
          fontSize: "18px",
        })
        .setOrigin(left ? 1 : 0, 0),
    );

    return {
      highlight,
      label: labelText,
      hpBar,
      hpNum,
      pips,
      trojan,
      moveBar,
      moveLabel,
      shot,
    };
  }

  /** Lock a game object to the camera (HUD overlay does not scroll). */
  private lock<T extends Phaser.GameObjects.Components.ScrollFactor>(obj: T): T {
    obj.setScrollFactor(0);
    return obj;
  }

  /**
   * Refresh every widget from live state. Called each frame from MatchScene.
   * `selectedShotId` is the firing player's current selection (shown in the
   * active cluster); `dtMs` drives the armed-pulse phase.
   */
  update(
    state: MatchState,
    controller: MatchController,
    selectedShotId: ShotId,
    dtMs: number,
  ): void {
    this.pulseT += dtMs / 1000;

    // --- Wind arrow + magnitude ---
    this.drawWindArrow(state.wind);
    this.windNum.setText(`${Math.abs(state.wind).toFixed(0)}`);

    // --- NEXT marker: lowest-accumulated-delay player (advanceTurn's rule) ---
    let next = state.players[0];
    for (const p of state.players) {
      if (p.accumulatedDelay < next.accumulatedDelay) next = p;
    }
    this.nextLabel.setText(`NEXT ▸ ${next.id.toUpperCase()}`);

    // --- Per-player clusters ---
    for (const p of state.players) {
      const cl = this.clusters[p.id];
      if (!cl) continue;
      const mech = state.mechs.find((m) => m.id === p.id);
      const hp = mech ? mech.hp : 0;
      const isActive = state.activePlayerId === p.id;
      const armed = controller.isSSArmed(p.id);

      cl.highlight.setVisible(isActive);
      cl.label.setColor(isActive ? "#22D3EE" : TEXT);

      this.drawHp(cl, hp);
      this.drawPips(cl, p.ssHitCharge, armed);
      this.drawMove(cl, p.moveBudget);

      cl.trojan.setText(
        armed ? "TROJAN — ARMED" : "TROJAN — LOCKED · LAND 3 HITS TO ARM",
      );
      cl.trojan.setColor(armed ? "#EF4444" : TEXT);

      // Selected-shot indicator lives on the ACTIVE cluster only.
      if (isActive) {
        cl.shot.setVisible(true);
        cl.shot.setText(this.shotLabel(selectedShotId));
        cl.shot.setColor(selectedShotId === "trojan" ? "#EF4444" : TEXT);
      } else {
        cl.shot.setVisible(false);
      }
    }
  }

  /** Draw the wind arrow: direction = sign(wind), length proportional to |wind|. */
  private drawWindArrow(wind: number): void {
    const g = this.windArrow;
    g.clear();
    const cx = this.w / 2;
    const cy = MARGIN + 12;
    const dir = wind >= 0 ? 1 : -1;
    const len = 10 + Math.min(40, (Math.abs(wind) / 80) * 40);

    g.lineStyle(3, 0xf8fafc, 1);
    g.beginPath();
    g.moveTo(cx - dir * len, cy);
    g.lineTo(cx + dir * len, cy);
    g.strokePath();
    // Arrowhead (two strokes, vector — never an emoji).
    g.beginPath();
    g.moveTo(cx + dir * len, cy);
    g.lineTo(cx + dir * (len - 8), cy - 6);
    g.moveTo(cx + dir * len, cy);
    g.lineTo(cx + dir * (len - 8), cy + 6);
    g.strokePath();
  }

  /** HP bar 120x12: green healthy -> red, forced critical-red below 25%. */
  private drawHp(cl: PlayerCluster, hp: number): void {
    const frac = Phaser.Math.Clamp(hp / 100, 0, 1);
    const critical = frac < 0.25;
    const fillInt = critical ? RED : Hud.lerpHpColor(frac);

    const g = cl.hpBar;
    const x = cl.label.x;
    const y = (cl.label.y as number) + 22;
    g.clear();
    g.fillStyle(SURFACE, 1);
    g.fillRect(x, y, HP_W, HP_H);
    g.fillStyle(fillInt, 1);
    g.fillRect(x, y, HP_W * frac, HP_H);

    // ALWAYS render the number (color-is-not-the-only-indicator).
    cl.hpNum.setText(`${Math.max(0, Math.round(hp))}`);
    cl.hpNum.setColor(critical ? "#EF4444" : TEXT);
  }

  /** Manual red(0)->green(1) lerp returning a packed 0xRRGGBB int. */
  private static lerpHpColor(frac: number): number {
    const t = Phaser.Math.Clamp(frac, 0, 1);
    const r = Math.round(0xef + (0x22 - 0xef) * t);
    const g = Math.round(0x44 + (0xc5 - 0x44) * t);
    const b = Math.round(0x44 + (0x5e - 0x44) * t);
    return (r << 16) | (g << 8) | b;
  }

  /** 3 charge pips: filled green / empty surface; armed -> color/opacity pulse. */
  private drawPips(cl: PlayerCluster, charge: number, armed: boolean): void {
    const g = cl.pips;
    const x = cl.label.x;
    const y = (cl.label.y as number) + 40;
    g.clear();

    // Armed pulse: oscillate opacity (NO scale transform — stable-animation rule).
    const pulse = armed ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.pulseT * 6)) : 1;

    for (let i = 0; i < SS_HITS_TO_ARM; i++) {
      const cx = x + PIP_R + i * (PIP_R * 2 + PIP_GAP);
      const filled = i < charge;
      g.fillStyle(filled ? GREEN : SURFACE, filled ? pulse : 1);
      g.fillCircle(cx, y, PIP_R);
    }
  }

  /** Depleting move-budget bar. */
  private drawMove(cl: PlayerCluster, budget: number): void {
    const frac = Phaser.Math.Clamp(budget / MOVE_BUDGET_PER_TURN, 0, 1);
    const g = cl.moveBar;
    const x = cl.label.x;
    const y = (cl.label.y as number) + 86;
    g.clear();
    g.fillStyle(SURFACE, 1);
    g.fillRect(x, y, MOVE_W, MOVE_H);
    g.fillStyle(CYAN, 1);
    g.fillRect(x, y, MOVE_W * frac, MOVE_H);
  }

  private shotLabel(id: ShotId): string {
    switch (id) {
      case "shot-1":
        return "SHOT 1";
      case "shot-2":
        return "SHOT 2";
      case "trojan":
        return "TROJAN";
    }
  }

  /** Hide the pre-match onboarding hint once the first shot fires. */
  clearIntro(): void {
    if (!this.introVisible) return;
    this.introVisible = false;
    this.introHeading.setVisible(false);
    this.introBody.setVisible(false);
  }

  /**
   * Flash a transient message at a WORLD point (e.g. OUT OF MOVE BUDGET /
   * BLOCKED near the active mech), auto-clearing after ~800ms.
   */
  flash(message: string, worldPoint: { x: number; y: number }): void {
    this.flashText
      .setText(message)
      .setPosition(worldPoint.x, worldPoint.y - 24)
      .setVisible(true);
    this.flashTimer?.remove();
    this.flashTimer = this.scene.time.delayedCall(800, () => {
      this.flashText.setVisible(false);
    });
  }

  /** Show the win banner (PLAY-07). Orbitron 48px + "R to rematch" sub-line. */
  showWinBanner(winnerLabel: string): void {
    this.banner.setText(`${winnerLabel} WINS`).setVisible(true);
    this.bannerSub.setVisible(true);
  }

  /** Reset for a fresh match (rematch): re-show intro, hide the banner. */
  reset(): void {
    this.banner.setVisible(false);
    this.bannerSub.setVisible(false);
    this.flashText.setVisible(false);
    this.introVisible = true;
    this.introHeading.setVisible(true);
    this.introBody.setVisible(true);
  }
}
