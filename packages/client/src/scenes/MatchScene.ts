import Phaser from "phaser";
import { TerrainMask } from "@shared/sim";
import type { Mech } from "@shared/sim";
import { MatchController } from "../match/MatchController.js";
import {
  createInitialState,
  GRAVITY,
  MOVE_BUDGET_PER_TURN,
} from "../match/MatchState.js";
import type { PlayerState } from "../match/MatchState.js";
import { buildShotInput } from "../match/aim.js";
import { LOADOUT } from "../match/loadout.js";
import type { ShotId } from "../match/loadout.js";
import { MechView } from "../view/MechView.js";
import { AimView } from "../view/AimView.js";
import { TerrainView } from "../view/TerrainView.js";
import { ProjectileView } from "../view/ProjectileView.js";
import { Fx } from "../view/Fx.js";
import { Hud } from "../view/Hud.js";
import type { MatchSceneData } from "./BootScene.js";
import {
  MAP,
  P1_ID,
  P2_ID,
  P1_START_X,
  P2_START_X,
  MECH_BODY_H,
  surfaceY,
} from "../world.js";

/**
 * Match scene (Phase 2, plan 04) — the complete hotseat loop + juice + HUD.
 *
 * Plan 03 captured ALL aim input (angle/walk/power/shot-select) and drew the
 * world + previews. Plan 04 adds the FIRE flow: releasing Space fires through
 * THE SEAM (`controller.applyShot`), animates the dot along `result.path` with a
 * follow-cam, then on impact carves the visual terrain, fires explosion + shake
 * + floating damage, advances the delay queue, pans to the next mech, rerolls
 * wind, and ends the match on last-mech-standing with an R rematch.
 *
 * SEAM INVARIANT (threats T-02-07/T-02-08): this Scene NEVER imports the sim's
 * outcome functions (resolveShot/simulateTrajectory/quantizeCarve) — it consumes
 * only the `ShotResult` returned by applyShot. A `firing`/`RESOLVING` gate stops
 * a turn firing or advancing twice.
 */

// --- Input tuning rates (recorded in the SUMMARY) ---
const ANGLE_RATE = 60; // deg/s
const WALK_SPEED = 80; // px/s
const SWEEP_RATE = 70; // power units/s (full 0-100 sweep ~1.4s)
const MAX_STEP_RISE = 14; // px: surface rise per step that BLOCKS a walk (steep wall)
const DRAG_SENSITIVITY = 0.5; // power units per px of horizontal drag

// --- Juice / camera timings (recorded in the SUMMARY) ---
const FOLLOW_LERP = 0.08; // follow-cam smoothing
const POST_IMPACT_MS = 380; // FX-settle delay before advancing the turn (<=500ms)
const PAN_MS = 500; // frame-next-mech camera pan (UI-SPEC max)
const MAX_SHAKE_MS = 300;
const SHAKE_PER_DAMAGE = 0.0006; // shake amplitude per HP of total damage

type Phase = "AIM" | "RESOLVING" | "OVER";

export class MatchScene extends Phaser.Scene {
  private mask!: MatchSceneData["mask"];
  private terrain!: TerrainView;
  private controller!: MatchController;
  private aimView!: AimView;
  private fx!: Fx;
  private hud!: Hud;

  private mechViews!: Record<string, MechView>;
  private mechs!: Mech[];

  private phase: Phase = "AIM";

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
  private keyR!: Phaser.Input.Keyboard.Key;

  constructor() {
    super("Match");
  }

  create(data: MatchSceneData): void {
    this.mask = data.mask;
    // Build the cosmetic terrain HERE (not in BootScene) so the world Image is
    // on THIS scene's display list — a BootScene-owned image is destroyed when
    // BootScene shuts down on scene.start, which is why the terrain was
    // invisible. Built first so mechs/aim/FX layer on top of it.
    this.terrain = TerrainView.build(this, this.mask);

    this.buildMatch();

    this.aimView = new AimView(this);
    this.fx = new Fx(this);
    this.hud = new Hud(this, [P1_ID, P2_ID]);

    // Camera: bound to the world (which may exceed the viewport) so follow/pan
    // stay inside the map.
    this.cameras.main.setBounds(0, 0, MAP.width, MAP.height);

    // --- Input registration ---
    const kb = this.input.keyboard;
    if (!kb) throw new Error("MatchScene requires a keyboard input plugin");
    this.cursors = kb.createCursorKeys();
    this.space = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.key1 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.key2 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.key3 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
    this.keyR = kb.addKey(Phaser.Input.Keyboard.KeyCodes.R);

    // Mouse-drag power (precise) on the same 0-100 scale as the gauge.
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.phase !== "AIM") return;
      this.dragMode = true;
      this.dragStartX = p.x;
      this.dragStartPower = this.power;
    });
    this.input.on("pointerup", () => {
      this.dragMode = false;
    });
  }

  /**
   * Build (or rebuild) the live match state, controller, mech models + views.
   * Reseats both mechs on the current mask surface and frames P1. Shared by
   * create() and the R rematch.
   */
  private buildMatch(): void {
    const { height } = this.mask;

    const p1y =
      surfaceY((x, y) => this.mask.isSolid(x, y), P1_START_X, height) - MECH_BODY_H / 2;
    const p2y =
      surfaceY((x, y) => this.mask.isSolid(x, y), P2_START_X, height) - MECH_BODY_H / 2;

    this.mechs = [
      { id: P1_ID, x: P1_START_X, y: p1y, hp: 100 },
      { id: P2_ID, x: P2_START_X, y: p2y, hp: 100 },
    ];

    // Facing (02-04 NO-GO fix 2): initial facing points toward the opponent /
    // map center — P1 (left) faces right (+1), P2 (right) faces left (-1) — so
    // P2 can aim left at P1 from the very first turn.
    const state = createInitialState(this.mechs, [
      { id: P1_ID, facing: 1 },
      { id: P2_ID, facing: -1 },
    ]);
    this.controller = new MatchController(this.mask, state);
    this.controller.rollWind();

    this.mechViews = {
      [P1_ID]: new MechView(this, this.mechs[0].x, this.mechs[0].y),
      [P2_ID]: new MechView(this, this.mechs[1].x, this.mechs[1].y),
    };
    this.mechViews[P1_ID].setActive(true);
    this.mechViews[P2_ID].setActive(false);
    this.mechViews[P1_ID].setFacing(1);
    this.mechViews[P2_ID].setFacing(-1);
    // Barrel uses the ABSOLUTE angle (relative angle through the active facing).
    this.mechViews[P1_ID].setBarrelAngle(this.absoluteAngle(1));
    this.mechViews[P2_ID].setBarrelAngle(this.absoluteAngle(-1));

    this.phase = "AIM";
    this.power = 0;
    this.charging = false;
    this.selectedShotId = "shot-1";
  }

  update(_t: number, dtMs: number): void {
    const dt = dtMs / 1000;

    // Rematch is available at any time the match is OVER.
    if (this.phase === "OVER") {
      if (Phaser.Input.Keyboard.JustDown(this.keyR)) this.rematch();
      this.hud.update(this.controller.state, this.controller, this.selectedShotId, dtMs);
      return;
    }

    // While the shot resolves, ignore all aim/move/fire input (threat T-02-08).
    if (this.phase === "RESOLVING") {
      this.hud.update(this.controller.state, this.controller, this.selectedShotId, dtMs);
      return;
    }

    const active = this.activeMech();
    const activeView = this.mechViews[active.id];
    const activePlayer = this.activePlayerState();

    // --- Angle (PLAY-01): the on-screen aim stays 0-90 RELATIVE to facing ---
    if (this.cursors.up.isDown) {
      this.angleDeg = Math.min(90, this.angleDeg + ANGLE_RATE * dt);
    }
    if (this.cursors.down.isDown) {
      this.angleDeg = Math.max(0, this.angleDeg - ANGLE_RATE * dt);
    }

    // --- Move (budget-limited walk, blocked by steep walls). Pressing a
    // direction also FACES that way (02-04 NO-GO fix 2) so "move left → aim
    // left", independent of whether the walk itself is allowed. ---
    if (this.cursors.left.isDown) {
      this.setActiveFacing(activePlayer, activeView, -1);
      this.tryWalk(active, activeView, -1, dt);
    }
    if (this.cursors.right.isDown) {
      this.setActiveFacing(activePlayer, activeView, 1);
      this.tryWalk(active, activeView, 1, dt);
    }

    // Barrel points along the ABSOLUTE angle (relative aim × current facing).
    activeView.setBarrelAngle(this.absoluteAngle(activePlayer.facing));

    // --- Power gauge: single-sweep, release FIRES (Pitfall 4: release-to-fire) ---
    if (Phaser.Input.Keyboard.JustDown(this.space)) {
      this.power = 0;
      this.charging = true;
    }
    if (this.charging && this.space.isDown) {
      this.power = Math.min(100, this.power + SWEEP_RATE * dt);
    }
    if (Phaser.Input.Keyboard.JustUp(this.space)) {
      this.charging = false;
      if (this.power > 0) {
        this.fire(active, activeView);
        return; // entered RESOLVING; skip the rest of this frame.
      }
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
    }

    // --- Preview render (PLAY-02). Indicator + dev arc consume the ABSOLUTE
    // angle so the preview, launch line, barrel, and fired shot all agree. ---
    const absAngle = this.absoluteAngle(activePlayer.facing);
    const muzzle = activeView.getMuzzle();
    this.aimView.drawLaunchIndicator(
      muzzle,
      absAngle,
      this.power,
      this.controller.state.wind,
    );
    this.aimView.drawDevArc({
      controller: this.controller,
      mech: active,
      angleDeg: absAngle,
      power: this.power,
      wind: this.controller.state.wind,
      gravity: this.controller.state.gravity,
      selectedShotId: this.selectedShotId,
    });

    this.hud.update(this.controller.state, this.controller, this.selectedShotId, dtMs);
  }

  /**
   * Fire the current shot through THE SEAM, animate it, and chain the impact +
   * turn-advance. Enters RESOLVING so the turn cannot fire/advance twice.
   */
  private fire(active: Mech, activeView: MechView): void {
    this.phase = "RESOLVING";
    this.hud.clearIntro();

    const def = LOADOUT[this.selectedShotId];

    // Launch from the barrel TIP so the dot leaves the muzzle. The relative aim
    // angle is converted to the sim's ABSOLUTE angle through the active player's
    // facing (02-04 NO-GO fix 2), so the fired arc matches the previewed barrel.
    const muzzle = activeView.getMuzzle();
    const aim = buildShotInput({
      mech: active,
      angleDeg: this.angleDeg,
      power: this.power,
      wind: this.controller.state.wind,
      gravity: GRAVITY,
      def,
      facing: this.activePlayerState().facing,
    });
    aim.x = muzzle.x;
    aim.y = muzzle.y;

    // THE SEAM CALL — the only outcome-producing path (Phase 3 swap point).
    const result = this.controller.applyShot(aim, def);

    const totalDamage = result.damage.reduce((s, d) => s + d.amount, 0);
    const blastRadius = def.blastRadius;

    const projectile = new ProjectileView(this);
    const cam = this.cameras.main;
    cam.startFollow(projectile.sprite, false, FOLLOW_LERP, FOLLOW_LERP);

    projectile.animateAlong(result.path, () => {
      cam.stopFollow();

      const impact = result.impact ?? result.path[result.path.length - 1] ?? null;

      // Repaint the visual terrain from the (already-carved) mask so craters
      // mirror the authoritative holes. `applyShot` carved this.mask in place
      // (same TerrainMask instance the controller holds), so this re-mirrors it.
      this.terrain.repaintFromMask(this.mask);

      if (impact) {
        this.fx.explode(impact, blastRadius);
        const intensity = Math.min(0.02, totalDamage * SHAKE_PER_DAMAGE);
        this.fx.shake(MAX_SHAKE_MS, intensity);
      }

      // Floating damage numbers at each damaged mech's position.
      this.fx.floatDamage(result.damage, (mechId) => {
        const m = this.mechs.find((mm) => mm.id === mechId);
        return m ? { x: m.x, y: m.y } : null;
      });

      // After the FX settle, advance the turn and frame the next mech.
      this.time.delayedCall(POST_IMPACT_MS, () => this.afterImpact());
    });
  }

  /** Advance the delay queue, reroll wind, frame the next mech, check the win. */
  private afterImpact(): void {
    const winnerId = this.controller.checkWin();
    if (winnerId) {
      this.endMatch(winnerId);
      return;
    }

    this.controller.advanceTurn();

    const nextId = this.controller.state.activePlayerId;
    // Refresh active outlines (cyan moves to the new active mech).
    for (const id of [P1_ID, P2_ID]) {
      this.mechViews[id].setActive(id === nextId);
    }

    // Point the new active mech's barrel along ITS facing (02-04 NO-GO fix 2).
    const nextPlayerState = this.controller.state.players.find((p) => p.id === nextId);
    if (nextPlayerState) {
      this.mechViews[nextId].setBarrelAngle(this.absoluteAngle(nextPlayerState.facing));
    }

    // Reset the new active player's per-turn move budget + roll fresh wind.
    const nextPlayer = this.controller.state.players.find((p) => p.id === nextId);
    if (nextPlayer) nextPlayer.moveBudget = MOVE_BUDGET_PER_TURN;
    this.controller.rollWind();

    // Frame the next active mech.
    const nextMech = this.mechs.find((m) => m.id === nextId);
    if (nextMech) {
      this.cameras.main.pan(nextMech.x, nextMech.y, PAN_MS, "Quad.easeInOut");
    }

    // Reset aim for the next turn and re-enable input.
    this.power = 0;
    this.charging = false;
    this.selectedShotId = "shot-1";
    this.phase = "AIM";
  }

  /** Last-mech-standing (PLAY-07): freeze input + show the win banner. */
  private endMatch(winnerId: string): void {
    this.phase = "OVER";
    for (const id of [P1_ID, P2_ID]) this.mechViews[id].setActive(false);
    this.hud.showWinBanner(winnerId.toUpperCase());
  }

  /**
   * R rematch (PLAY-07, non-destructive): rebuild a FRESH uncarved mask + the
   * cosmetic terrain texture, rebuild the match state/controller, reset both
   * mechs to 100 HP at their start positions, reset the HUD, and re-center P1.
   */
  private rematch(): void {
    // Tear down old world views so the rebuild starts clean.
    for (const id of [P1_ID, P2_ID]) {
      this.mechViews[id].destroy();
    }
    this.terrain.destroy();

    // Fresh, uncarved authority + cosmetic mirror.
    this.mask = TerrainMask.fromMap(MAP);
    this.terrain = TerrainView.build(this, this.mask);

    this.angleDeg = 45;
    this.buildMatch();
    this.hud.reset();

    const p1 = this.mechs[0];
    this.cameras.main.stopFollow();
    this.cameras.main.centerOn(p1.x, p1.y);
  }

  /**
   * Attempt one walk step. Reads the collision mask for the ground at the
   * candidate X and BLOCKS the move if the surface rise exceeds MAX_STEP_RISE
   * (the "steep wall" rule, client-side, no sim change). Decrements moveBudget
   * by the distance actually walked; clamps when the budget is spent.
   */
  private tryWalk(mech: Mech, view: MechView, dir: -1 | 1, dt: number): void {
    const player = this.controller.state.players.find((p) => p.id === mech.id);
    if (!player) return;
    if (player.moveBudget <= 0) {
      this.hud.flash("OUT OF MOVE BUDGET", { x: mech.x, y: mech.y });
      return;
    }

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
    if (rise > MAX_STEP_RISE) {
      this.hud.flash("BLOCKED", { x: mech.x, y: mech.y });
      return;
    }

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

  /** The active player's turn-economy state (holds the aim `facing`). */
  private activePlayerState(): PlayerState {
    const id = this.controller.state.activePlayerId;
    const p = this.controller.state.players.find((pl) => pl.id === id);
    if (!p) throw new Error(`active player ${id} not found`);
    return p;
  }

  /**
   * Convert the on-screen 0–90 relative aim into the sim's absolute angle for a
   * given facing (mirror of buildShotInput's rule): facing +1 → angle;
   * facing -1 → 180 - angle. Used for the barrel + preview so they match the
   * fired shot exactly.
   */
  private absoluteAngle(facing: 1 | -1): number {
    return facing === 1 ? this.angleDeg : 180 - this.angleDeg;
  }

  /** Set the active player's facing (on ←/→) and flip the chassis to match. */
  private setActiveFacing(
    player: PlayerState,
    view: MechView,
    facing: 1 | -1,
  ): void {
    if (player.facing === facing) return;
    player.facing = facing;
    view.setFacing(facing);
  }
}
