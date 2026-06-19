import Phaser from "phaser";
import type { MatchController } from "../match/MatchController.js";
import type { MatchState } from "../match/MatchState.js";
import { SS_HITS_TO_ARM, MOVE_BUDGET_PER_TURN } from "../match/MatchState.js";
import type { ShotId } from "../match/loadout.js";

/**
 * Screen-space HUD overlay (Phase 02.1, plan 03) — HUD-01 / HUD-02.
 *
 * The Phase-2 floating per-player clusters are GONE. They are replaced by a
 * single bottom-fixed bar pinned to the VIEWPORT bottom (`setScrollFactor(0)`):
 * left→right zones SHOT-SELECT · (active control: SS pips + MOVE) · POWER ·
 * SCORE-stub · TURN list. Wind STAYS top-center (unchanged). HP left the HUD
 * entirely — it now floats above each mech in-world (MechView, this plan).
 *
 * Every bar widget is scroll-locked via `lock()` so it stays fixed while the
 * follow-cam / right-drag pan scrolls the larger world. The bar pins to the
 * VIEWPORT bottom (`cam.height - BAR_H`), NEVER the world bottom (Pitfall 3).
 * NO emoji glyphs — the wind arrow, charge pips and TRJ lock are drawn vector
 * shapes (ui-ux-pro-max no-emoji rule). Color is never the only signal: the
 * selected shot shows its glyph, the next player gets a position + NEXT marker.
 *
 * Palette (UI-SPEC): field `#0F172A`, surface `#1E293B`/`#334155`, text
 * `#F8FAFC`, cyan `#22D3EE` (reserved: selected-chip border, power fill, MOVE
 * fill, turn highlight + NEXT marker), status green `#22C55E`, threat red
 * `#EF4444`. Typography: Share Tech Mono numerics, Fira Code labels, Orbitron
 * win banner.
 *
 * PUBLIC CONTRACT (held identical so MatchScene needs no Hud-call edit): the
 * constructor `(scene, playerIds)`, and `flash` / `clearIntro` / `showWinBanner`
 * / `reset`. `update(...)` only GAINS an optional 5th `power?` param.
 *
 * Pure view: imports match TYPES + constants only, never a sim outcome function
 * (ESLint seam guard on view/**).
 */

const TEXT = "#F8FAFC";
const CYAN = 0x22d3ee;
const GREEN = 0x22c55e;
const RED = 0xef4444;
const BAR_FILL = 0x1e293b;
const SURFACE = 0x334155;

// --- Bottom-bar fixed dimensions (UI-SPEC verbatim) ---
const BAR_H = 96; // bar height, pinned to viewport bottom, full width
const BAR_PAD = 16; // md: vertical padding inside the bar
const EDGE = 24; // lg: bar inset from the left/right screen edges

const CHIP = 56; // shot-select chip 56x56
const CHIP_GAP = 8; // sm: gap between chips

const PIP_R = 5;
const PIP_GAP = 4; // xs

const MOVE_W = 120;
const MOVE_H = 8;

const POWER_W = 240; // power meter 240x20
const POWER_H = 20;

const SCORE_W = 120; // score-stub slot 120x56
const SCORE_H = 56;

const TURN_ROW_H = 28; // turn-list row height
const TURN_INSET = 4; // xs

// Wind widget rows (top-center), each clear of the next (no overlap).
const MARGIN = 24; // lg: top inset for the wind widget
const WIND_ARROW_Y = MARGIN + 22; // arrow centerline, below the "WIND" label
const WIND_NUM_Y = MARGIN + 34; // magnitude number, below the arrow

const LABEL_STYLE = {
  fontFamily: "'Fira Code'",
  fontSize: "14px",
  color: TEXT,
} as const;
const LABEL_SM_STYLE = {
  fontFamily: "'Fira Code'",
  fontSize: "12px",
  color: TEXT,
} as const;
const NUM_STYLE = {
  fontFamily: "'Share Tech Mono'",
  fontSize: "24px",
  color: TEXT,
} as const;
const NUM_SM_STYLE = {
  fontFamily: "'Share Tech Mono'",
  fontSize: "16px",
  color: TEXT,
} as const;

/** The three selectable shot chips, in bar order. */
const CHIP_DEFS: { id: ShotId; glyph: string }[] = [
  { id: "shot-1", glyph: "1" },
  { id: "shot-2", glyph: "2" },
  { id: "trojan", glyph: "TRJ" },
];

export class Hud {
  private readonly w: number;
  private readonly h: number;
  private readonly barTop: number;

  // Wind (top-center).
  private readonly windLabel: Phaser.GameObjects.Text;
  private readonly windArrow: Phaser.GameObjects.Graphics;
  private readonly windNum: Phaser.GameObjects.Text;

  // Bar chrome (fill + divider).
  private readonly barG: Phaser.GameObjects.Graphics;

  // Shot-select zone.
  private readonly shotCaption: Phaser.GameObjects.Text;
  private readonly chipG: Phaser.GameObjects.Graphics; // chip borders / fills / TRJ lock
  private readonly chipText: Phaser.GameObjects.Text[] = [];
  private readonly chipX: number[] = []; // chip left edges (computed once)
  private chipY = 0;

  // Active-player control zone (SS pips + MOVE budget).
  private readonly pips: Phaser.GameObjects.Graphics;
  private readonly moveCaption: Phaser.GameObjects.Text;
  private readonly moveBar: Phaser.GameObjects.Graphics;
  private pipsY = 0;
  private moveBarY = 0;
  private controlX = 0;

  // Power zone.
  private readonly powerCaption: Phaser.GameObjects.Text;
  private readonly powerBar: Phaser.GameObjects.Graphics;
  private readonly powerNum: Phaser.GameObjects.Text;
  private powerX = 0;
  private powerBarY = 0;

  // Score-stub zone.
  private readonly scoreCaption: Phaser.GameObjects.Text;
  private readonly scoreValue: Phaser.GameObjects.Text;

  // Turn-list zone.
  private readonly turnCaption: Phaser.GameObjects.Text;
  private readonly turnG: Phaser.GameObjects.Graphics; // row highlights
  private readonly turnRows: Phaser.GameObjects.Text[] = [];
  private readonly turnX: number;
  private turnRowsTop = 0;

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
    this.h = cam.height;
    // Pin to the VIEWPORT bottom — cam.height - 96, never the world height
    // (Pitfall 3). BAR_H is 96; the literal is kept here for the bottom pin.
    this.barTop = cam.height - 96; // === cam.height - BAR_H

    // --- WIND (top-center) — UNCHANGED from Phase 2. Stacked in clear rows so
    // label, arrow and magnitude never overlap. ---
    this.windLabel = this.lock(
      scene.add.text(this.w / 2, MARGIN, "WIND", LABEL_STYLE).setOrigin(0.5, 0),
    );
    this.windArrow = this.lock(scene.add.graphics()); // drawn at WIND_ARROW_Y
    this.windNum = this.lock(
      scene.add.text(this.w / 2, WIND_NUM_Y, "0", NUM_STYLE).setOrigin(0.5, 0),
    );

    // --- BAR CHROME: full-width 96px rect + top divider, pinned to viewport bottom ---
    this.barG = this.lock(scene.add.graphics());
    this.barG.fillStyle(BAR_FILL, 1);
    this.barG.fillRect(0, this.barTop, this.w, BAR_H);
    this.barG.lineStyle(2, SURFACE, 1);
    this.barG.beginPath();
    this.barG.moveTo(0, this.barTop);
    this.barG.lineTo(this.w, this.barTop);
    this.barG.strokePath();

    const captionY = this.barTop + BAR_PAD; // zone captions sit on the top pad row
    const rowY = captionY + 20; // widget row below its caption

    // --- SHOT-SELECT zone (left) ---
    this.shotCaption = this.lock(
      scene.add.text(EDGE, captionY, "SHOT", LABEL_STYLE).setOrigin(0, 0),
    );
    this.chipG = this.lock(scene.add.graphics());
    this.chipY = rowY;
    CHIP_DEFS.forEach((def, i) => {
      const x = EDGE + i * (CHIP + CHIP_GAP);
      this.chipX.push(x);
      this.chipText.push(
        this.lock(
          scene.add
            .text(x + CHIP / 2, this.chipY + CHIP / 2, def.glyph, LABEL_SM_STYLE)
            .setOrigin(0.5),
        ),
      );
    });

    // --- ACTIVE-PLAYER CONTROL zone (SS pips + MOVE), adjacent to shot-select ---
    this.controlX = EDGE + 3 * (CHIP + CHIP_GAP) + 24;
    this.pipsY = this.chipY + 10;
    this.moveBarY = this.chipY + CHIP - MOVE_H;
    this.pips = this.lock(scene.add.graphics());
    this.moveCaption = this.lock(
      scene.add
        .text(this.controlX, this.moveBarY - 16, "MOVE", LABEL_SM_STYLE)
        .setOrigin(0, 0),
    );
    this.moveBar = this.lock(scene.add.graphics());

    // --- POWER zone (center-left) ---
    this.powerX = this.controlX + MOVE_W + 32;
    this.powerCaption = this.lock(
      scene.add.text(this.powerX, captionY, "POWER", LABEL_STYLE).setOrigin(0, 0),
    );
    this.powerBarY = rowY;
    this.powerBar = this.lock(scene.add.graphics());
    this.powerNum = this.lock(
      scene.add
        .text(this.powerX + POWER_W + 12, this.powerBarY + POWER_H / 2, "0%", NUM_STYLE)
        .setOrigin(0, 0.5),
    );

    // --- SCORE-stub zone (center-right) ---
    const scoreX = this.powerX + POWER_W + 96;
    this.scoreCaption = this.lock(
      scene.add.text(scoreX, captionY, "SCORE", LABEL_STYLE).setOrigin(0, 0),
    );
    this.scoreValue = this.lock(
      scene.add
        .text(scoreX + SCORE_W / 2, rowY + SCORE_H / 2 - 16, "0", NUM_STYLE)
        .setOrigin(0.5, 0.5),
    );

    // --- TURN list zone (right) ---
    this.turnX = this.w - EDGE - 120;
    this.turnCaption = this.lock(
      scene.add.text(this.turnX, captionY, "TURN", LABEL_STYLE).setOrigin(0, 0),
    );
    this.turnRowsTop = rowY;
    this.turnG = this.lock(scene.add.graphics());
    // One row per player, sorted live by accumulatedDelay in update(). Pre-create
    // a row text per player so scaling to P3/P4 later is just more entries.
    playerIds.forEach((_, i) => {
      this.turnRows.push(
        this.lock(
          scene.add
            .text(
              this.turnX + TURN_INSET + 8,
              this.turnRowsTop + i * TURN_ROW_H + TURN_ROW_H / 2,
              "",
              NUM_SM_STYLE,
            )
            .setOrigin(0, 0.5),
        ),
      );
    });

    // --- Pre-match onboarding hint (intro body appends the pan/recenter keys) ---
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
          "P1 — set angle, power, fire.  ↑↓ aim · ←→ move · hold SPACE to charge.  ·  RIGHT-DRAG to pan · C to recenter",
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

  /** Lock a game object to the camera (HUD overlay does not scroll). */
  private lock<T extends Phaser.GameObjects.Components.ScrollFactor>(obj: T): T {
    obj.setScrollFactor(0);
    return obj;
  }

  /**
   * Refresh the bottom bar from live state. Called each frame from MatchScene.
   * `selectedShotId` is the active player's current selection; `dtMs` drives the
   * armed-pulse phase; `power` (optional, default 0) drives the power meter — the
   * new 5th param keeps the existing 4-arg call sites valid (MatchScene passes
   * `this.power`).
   */
  update(
    state: MatchState,
    controller: MatchController,
    selectedShotId: ShotId,
    dtMs: number,
    power = 0,
  ): void {
    this.pulseT += dtMs / 1000;

    // --- Wind arrow + magnitude (top-center, unchanged) ---
    this.drawWindArrow(state.wind);
    this.windNum.setText(`${Math.abs(state.wind).toFixed(0)}`);

    const activeId = state.activePlayerId;
    const armed = controller.isSSArmed(activeId);
    const activePlayer = state.players.find((p) => p.id === activeId);

    // --- Shot-select chips ---
    this.drawChips(selectedShotId, armed);

    // --- Active-player control: SS pips + MOVE budget ---
    this.drawPips(activePlayer ? activePlayer.ssHitCharge : 0, armed);
    this.drawMove(activePlayer ? activePlayer.moveBudget : 0);

    // --- Power meter ---
    this.drawPower(power);

    // --- Turn list: rows ordered by lowest accumulatedDelay (acts next first) ---
    this.drawTurnList(state);
  }

  /** Shot-select chips: selected gets the cyan border; TRJ is locked until armed. */
  private drawChips(selectedShotId: ShotId, armed: boolean): void {
    const g = this.chipG;
    g.clear();
    CHIP_DEFS.forEach((def, i) => {
      const x = this.chipX[i];
      const y = this.chipY;
      const isTrojan = def.id === "trojan";
      const selected = def.id === selectedShotId;
      const locked = isTrojan && !armed;

      // Base fill (dimmed when the TRJ chip is locked).
      g.fillStyle(SURFACE, locked ? 0.4 : 1);
      g.fillRect(x, y, CHIP, CHIP);

      // Selected chip border = cyan (reserved #5); TRJ selected additionally
      // tints threat-red, but the cyan border still marks selection.
      if (selected) {
        if (isTrojan) {
          g.fillStyle(RED, 0.25);
          g.fillRect(x, y, CHIP, CHIP);
        }
        g.lineStyle(2, CYAN, 1);
        g.strokeRect(x, y, CHIP, CHIP);
      }

      // Locked TRJ: a small vector lock affordance (NEVER an emoji).
      if (locked) {
        const lx = x + CHIP / 2;
        const ly = y + 14;
        g.lineStyle(2, 0xf8fafc, 0.6);
        g.strokeRect(lx - 5, ly, 10, 8); // lock body
        g.beginPath(); // shackle arc approximated with two strokes
        g.moveTo(lx - 3, ly);
        g.lineTo(lx - 3, ly - 4);
        g.lineTo(lx + 3, ly - 4);
        g.lineTo(lx + 3, ly);
        g.strokePath();
      }

      this.chipText[i].setColor(locked ? "rgba(248,250,252,0.5)" : TEXT);
    });
  }

  /** Draw the wind arrow: direction = sign(wind), length proportional to |wind|. */
  private drawWindArrow(wind: number): void {
    const g = this.windArrow;
    g.clear();
    const cx = this.w / 2;
    const cy = WIND_ARROW_Y;
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

  /** 3 charge pips: filled green / empty surface; armed -> color/opacity pulse. */
  private drawPips(charge: number, armed: boolean): void {
    const g = this.pips;
    const x = this.controlX;
    const y = this.pipsY;
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

  /** Depleting MOVE-budget bar (cyan reserved #: in-bar controllable state). */
  private drawMove(budget: number): void {
    const frac = Phaser.Math.Clamp(budget / MOVE_BUDGET_PER_TURN, 0, 1);
    const g = this.moveBar;
    const x = this.controlX;
    const y = this.moveBarY;
    g.clear();
    g.fillStyle(SURFACE, 1);
    g.fillRect(x, y, MOVE_W, MOVE_H);
    g.fillStyle(CYAN, 1);
    g.fillRect(x, y, MOVE_W * frac, MOVE_H);
  }

  /** Power meter 240x20: cyan fill scaled to power 0-100 + a NN% readout. */
  private drawPower(power: number): void {
    const frac = Phaser.Math.Clamp(power / 100, 0, 1);
    const g = this.powerBar;
    const x = this.powerX;
    const y = this.powerBarY;
    g.clear();
    g.fillStyle(SURFACE, 1);
    g.fillRect(x, y, POWER_W, POWER_H);
    g.fillStyle(CYAN, 1);
    g.fillRect(x, y, POWER_W * frac, POWER_H);
    this.powerNum.setText(`${Math.round(power)}%`);
  }

  /**
   * Turn list: one row per player, sorted by lowest accumulatedDelay (the same
   * advanceTurn "acts next" rule the bar renders). The next-up row gets the cyan
   * highlight + a `NEXT ▸` marker. Structured so adding P3/P4 is just more rows.
   */
  private drawTurnList(state: MatchState): void {
    const ordered = [...state.players].sort(
      (a, b) => a.accumulatedDelay - b.accumulatedDelay,
    );
    const g = this.turnG;
    g.clear();

    ordered.forEach((p, i) => {
      const row = this.turnRows[i];
      if (!row) return;
      const isNext = i === 0;
      const top = this.turnRowsTop + i * TURN_ROW_H;

      if (isNext) {
        g.fillStyle(CYAN, 0.2);
        g.fillRect(this.turnX, top, 120, TURN_ROW_H);
        g.lineStyle(2, CYAN, 1);
        g.strokeRect(this.turnX, top, 120, TURN_ROW_H);
      }

      const label = p.id.toUpperCase();
      row.setText(isNext ? `${label}  NEXT ▸` : label);
      row.setColor(isNext ? "#22D3EE" : TEXT);
    });
    // Hide any leftover pre-created rows (e.g. if fewer players than rows).
    for (let i = ordered.length; i < this.turnRows.length; i++) {
      this.turnRows[i].setText("");
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
