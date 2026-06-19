import Phaser from "phaser";
import type { Mech } from "@shared/sim";
import { MatchController } from "../match/MatchController.js";
import { createInitialState } from "../match/MatchState.js";
import type { ShotId } from "../match/loadout.js";
import { MechView } from "../view/MechView.js";
import { AimView } from "../view/AimView.js";
import type { MatchSceneData } from "./BootScene.js";
import {
  P1_ID,
  P2_ID,
  P1_START_X,
  P2_START_X,
  MECH_BODY_H,
  surfaceY,
} from "../world.js";

/**
 * Match scene (Phase 2, plan 03) — PLAY-01 input + PLAY-02 preview.
 *
 * Captures ALL aim input (angle, walk, single-sweep power gauge, mouse-drag
 * power, shot select), draws the world (two mechs + the production launch
 * indicator + the dev full-arc overlay). It constructs the MatchController and
 * routes the dev arc through previewTrajectory() — it NEVER calls the sim's
 * outcome functions directly (ESLint seam guard on scenes/**).
 *
 * Firing + juice + HUD + win land in plan 04. SEAM FOR PLAN 04: releasing
 * Space currently only LOCKS power (see JustUp handling); plan 04 adds the
 * fire-on-release path there — call controller.applyShot(buildShotInput({...},
 * LOADOUT[selectedShotId]), LOADOUT[selectedShotId]) then advanceTurn() and
 * feed the result to TerrainView.applyCarves + projectile animation.
 */

// --- Input tuning rates (recorded in the SUMMARY) ---
const ANGLE_RATE = 60; // deg/s
const WALK_SPEED = 80; // px/s
const SWEEP_RATE = 70; // power units/s (full 0-100 sweep ~1.4s)
const MAX_STEP_RISE = 14; // px: surface rise per step that BLOCKS a walk (steep wall)
const DRAG_SENSITIVITY = 0.5; // power units per px of horizontal drag

export class MatchScene extends Phaser.Scene {
  private mask!: MatchSceneData["mask"];
  /** Cosmetic terrain mirror; plan 04 calls `terrain.applyCarves(result.carves)`. */
  private terrain!: MatchSceneData["terrain"];
  private controller!: MatchController;
  private aimView!: AimView;

  private mechViews!: Record<string, MechView>;
  private mechs!: Mech[];

  // Live aim state.
  private angleDeg = 45;
  private power = 0;
  private charging = false;
  private dragMode = false;
  private dragStartX = 0;
  private dragStartPower = 0;
  private selectedShotId: ShotId = "shot-1";

  // Input handles.
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private space!: Phaser.Input.Keyboard.Key;
  private key1!: Phaser.Input.Keyboard.Key;
  private key2!: Phaser.Input.Keyboard.Key;
  private key3!: Phaser.Input.Keyboard.Key;

  constructor() {
    super("Match");
  }

  create(data: MatchSceneData): void {
    this.mask = data.mask;
    this.terrain = data.terrain;
    const { height } = this.mask;

    // Seat each mech on the procedural surface at its start X (body center sits
    // half a body above the ground line).
    const p1y = surfaceY((x, y) => this.mask.isSolid(x, y), P1_START_X, height) - MECH_BODY_H / 2;
    const p2y = surfaceY((x, y) => this.mask.isSolid(x, y), P2_START_X, height) - MECH_BODY_H / 2;

    this.mechs = [
      { id: P1_ID, x: P1_START_X, y: p1y, hp: 100 },
      { id: P2_ID, x: P2_START_X, y: p2y, hp: 100 },
    ];

    const state = createInitialState(this.mechs, [{ id: P1_ID }, { id: P2_ID }]);
    this.controller = new MatchController(this.mask, state);
    this.controller.rollWind();

    // Mech views; P1 is active first (cyan outline cue).
    this.mechViews = {
      [P1_ID]: new MechView(this, this.mechs[0].x, this.mechs[0].y),
      [P2_ID]: new MechView(this, this.mechs[1].x, this.mechs[1].y),
    };
    this.mechViews[P1_ID].setActive(true);
    this.mechViews[P2_ID].setActive(false);
    this.mechViews[P1_ID].setBarrelAngle(this.angleDeg);

    this.aimView = new AimView(this);

    // --- Input registration ---
    const kb = this.input.keyboard;
    if (!kb) throw new Error("MatchScene requires a keyboard input plugin");
    this.cursors = kb.createCursorKeys();
    this.space = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.key1 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.key2 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.key3 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);

    // Mouse-drag power (precise) on the same 0-100 scale as the gauge.
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.dragMode = true;
      this.dragStartX = p.x;
      this.dragStartPower = this.power;
    });
    this.input.on("pointerup", () => {
      this.dragMode = false;
    });
  }

  update(_t: number, dtMs: number): void {
    const dt = dtMs / 1000;
    const active = this.activeMech();
    const activeView = this.mechViews[active.id];

    // --- Angle (PLAY-01): clamp 0-90 ---
    if (this.cursors.up.isDown) {
      this.angleDeg = Math.min(90, this.angleDeg + ANGLE_RATE * dt);
    }
    if (this.cursors.down.isDown) {
      this.angleDeg = Math.max(0, this.angleDeg - ANGLE_RATE * dt);
    }
    activeView.setBarrelAngle(this.angleDeg);

    // --- Move (budget-limited walk, blocked by steep walls) ---
    if (this.cursors.left.isDown) this.tryWalk(active, activeView, -1, dt);
    if (this.cursors.right.isDown) this.tryWalk(active, activeView, 1, dt);

    // --- Power gauge: single-sweep, release-locks (Pattern 3, Pitfall 4) ---
    if (Phaser.Input.Keyboard.JustDown(this.space)) {
      this.power = 0;
      this.charging = true;
    }
    if (this.charging && this.space.isDown) {
      this.power = Math.min(100, this.power + SWEEP_RATE * dt);
    }
    if (Phaser.Input.Keyboard.JustUp(this.space)) {
      // LOCK power. (Plan 04 adds fire-on-release here.)
      this.charging = false;
    }

    // --- Mouse-drag power (precise) ---
    if (this.dragMode && this.input.activePointer.isDown) {
      const delta = (this.input.activePointer.x - this.dragStartX) * DRAG_SENSITIVITY;
      this.power = Phaser.Math.Clamp(this.dragStartPower + delta, 0, 100);
    }

    // --- Shot select (1/2/3); Trojan only when armed ---
    if (Phaser.Input.Keyboard.JustDown(this.key1)) this.selectedShotId = "shot-1";
    if (Phaser.Input.Keyboard.JustDown(this.key2)) this.selectedShotId = "shot-2";
    if (Phaser.Input.Keyboard.JustDown(this.key3)) {
      if (this.controller.isSSArmed(this.controller.state.activePlayerId)) {
        this.selectedShotId = "trojan";
      }
      // else: ignore (locked-state HUD copy is plan 04).
    }

    // --- Preview render (PLAY-02) ---
    const muzzle = activeView.getMuzzle();
    this.aimView.drawLaunchIndicator(
      muzzle,
      this.angleDeg,
      this.power,
      this.controller.state.wind,
    );
    this.aimView.drawDevArc({
      controller: this.controller,
      mech: active,
      angleDeg: this.angleDeg,
      power: this.power,
      wind: this.controller.state.wind,
      gravity: this.controller.state.gravity,
      selectedShotId: this.selectedShotId,
    });
  }

  /**
   * Attempt one walk step. Reads the collision mask for the ground at the
   * candidate X and BLOCKS the move if the surface rise exceeds MAX_STEP_RISE
   * (the "steep wall" rule, client-side, no sim change). Decrements moveBudget
   * by the distance actually walked; clamps when the budget is spent.
   */
  private tryWalk(
    mech: Mech,
    view: MechView,
    dir: -1 | 1,
    dt: number,
  ): void {
    const player = this.controller.state.players.find((p) => p.id === mech.id);
    if (!player || player.moveBudget <= 0) return;

    const step = Math.min(WALK_SPEED * dt, player.moveBudget);
    const candidateX = mech.x + dir * step;
    if (candidateX < 0 || candidateX >= this.mask.width) return;

    const currentSurface = surfaceY(
      (x, y) => this.mask.isSolid(x, y),
      Math.round(mech.x),
      this.mask.height,
    );
    const candidateSurface = surfaceY(
      (x, y) => this.mask.isSolid(x, y),
      Math.round(candidateX),
      this.mask.height,
    );

    // Surface rise = ground getting HIGHER (smaller y, y-down). Block steep walls.
    const rise = currentSurface - candidateSurface;
    if (rise > MAX_STEP_RISE) return; // BLOCKED.

    mech.x = candidateX;
    mech.y = candidateSurface - MECH_BODY_H / 2;
    view.setPosition(mech.x, mech.y);
    player.moveBudget = Math.max(0, player.moveBudget - step);
  }

  private activeMech(): Mech {
    const id = this.controller.state.activePlayerId;
    const m = this.mechs.find((mech) => mech.id === id);
    if (!m) throw new Error(`active mech ${id} not found`);
    return m;
  }
}
