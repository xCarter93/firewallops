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
import type { ShotResult } from "../match/shotResult.js";
import { MechView } from "../view/MechView.js";
import { AimView } from "../view/AimView.js";
import { TerrainView } from "../view/TerrainView.js";
import { ProjectileView } from "../view/ProjectileView.js";
import { Fx } from "../view/Fx.js";
import { Hud } from "../view/Hud.js";
import type { MatchSceneData } from "./BootScene.js";
import { connectToMatch, sendAim, sendFire, sendSelectItem } from "../net/room.js";
import { ShotResultBridge } from "../net/shotResultBridge.js";
import type { Room } from "@colyseus/sdk";
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
 * Match scene (Phase 2, plan 04 + Phase 3, plan 04) — hotseat loop + networked
 * authority client.
 *
 * HOTSEAT (VITE_NETWORKED off — the Phase 2 DEFAULT dev loop, unchanged): the
 * complete local loop + juice + HUD. Firing routes through THE SEAM
 * (`controller.applyShot`), animates along `result.path`, then on impact carves
 * the visual terrain, fires FX, advances the local delay queue (`afterImpact`),
 * rerolls wind, and ends on last-mech-standing with an R rematch.
 *
 * NETWORKED (VITE_NETWORKED=1 — Phase 3 / Authority Decision 6, opt-in): the
 * client connects to the Colyseus room and becomes a pure broadcast mirror. HP
 * and terrain mutate ONLY when the server `shotResult` broadcast arrives (via
 * `animateShot`, the single mutation source). Active player, wind, HP, terrain,
 * and ALL phase transitions come ONLY from `syncFromState`. `applyShot` is
 * fire-and-forget (the controller forwards to the injected `sendFire`); the
 * local turn/wind/win machine (`afterImpact`) is DEAD in this mode. Input is
 * gated on synced AIMING + sessionId + `isAnimatingShot`.
 *
 * SEAM INVARIANT (threats T-02-07/T-02-08): this Scene NEVER imports the sim's
 * outcome functions (resolveShot/simulateTrajectory/quantizeCarve). The local
 * preview is the only local-sim use, and it routes through
 * `controller.previewTrajectory`.
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

// --- Networked aim streaming (Phase 3) ---
const AIM_THROTTLE_MS = 100; // max one aim message per ~100ms (Suggestion #8)
// Local mirror of the server TURN_MS (server config.ts). Used ONLY for the
// minimal countdown anchor — the server is the real timeout authority. Drift of
// ~RTT is acceptable this phase (no server-time offset; CONTEXT minimal-countdown).
const TURN_MS_LOCAL = 20_000;

// --- Camera framing (CAM-02). The active mech is framed in the LOWER THIRD of
// the viewport so it clears the bottom bar and leaves the bulk of the screen as
// sky/arc room above. ---
const BAR_CLEARANCE = 96; // bottom-bar height to clear (matches plan 03 BAR_H = 96)
const FRAME_FRAC = 0.66;
const SKY_HEADROOM = 640;

type Phase = "AIM" | "RESOLVING" | "OVER";

/** The synced Mobile shape the scene reads (server schema, read-only mirror). */
interface SyncedMobile {
  sessionId: string;
  team: number;
  x: number;
  y: number;
  hp: number;
  angleDeg: number;
  power: number;
  facing: number;
  ssHitCharge: number;
  accumulatedDelay: number;
  selectedItemId: string;
}

/** The synced MatchState shape the scene reads. */
interface SyncedState {
  phase: string;
  activePlayer: string;
  wind: number;
  turnEndsAt: number;
  winnerTeam: number;
  mobiles: {
    forEach(cb: (mobile: SyncedMobile, key: string) => void): void;
    size: number;
  };
}

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

  // Right-drag free-pan latch (CAM-01).
  private manualPan = false;

  // --- Networked state (Phase 3) ---
  private networked = false;
  private room?: Room;
  private sessionId = "";
  private syncedPhase = "WAITING";
  private activePlayerId = "";
  private isAnimatingShot = false;
  private lastAimSentAt = 0;
  // Latest synced absolute HP per sessionId (the authoritative reconcile source).
  private syncedHp: Record<string, number> = {};
  // Latest synced absolute Y per sessionId — the authoritative settle target,
  // reconciled (tweened) on animation-land like HP, never applied mid-shot.
  private syncedY: Record<string, number> = {};
  // Latest synced SS-charge for the LOCAL player (gates Trojan selection; the
  // server is the real arming authority and rejects an unearned Trojan).
  private localSsCharge = 0;
  // The LOCAL player's server-synced facing (1 = right toward higher x, -1 =
  // left toward lower x), captured each patch in syncFromState and used for the
  // local aim preview, barrel, and fired shot. Replaces the old hardcoded
  // facing-1 networked approximation so a Team-B player aims/fires toward Team A
  // (NET-06).
  private localFacing: 1 | -1 = 1;
  // A terrain snapshot that arrived mid-animation is queued, applied on land.
  private pendingTerrain?: TerrainMask;
  private syncedWind = 0;
  private turnEndsAt = 0;
  // Local countdown anchor: the game-time ms at which the current turn expires.
  // Re-anchored whenever the server's turnEndsAt value changes (a new turn).
  private localTurnDeadline = 0;
  private lastTurnEndsAt = -1;
  // One-shot initial camera framing once the local mech first appears in state.
  private framedOnLocal = false;
  // The active player the camera is currently framed on (re-frames each turn).
  private lastFramedActive = "";

  // Input handles.
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private space!: Phaser.Input.Keyboard.Key;
  private key1!: Phaser.Input.Keyboard.Key;
  private key2!: Phaser.Input.Keyboard.Key;
  private key3!: Phaser.Input.Keyboard.Key;
  private keyR!: Phaser.Input.Keyboard.Key;
  private keyC!: Phaser.Input.Keyboard.Key;

  constructor() {
    super("Match");
  }

  create(data: MatchSceneData): void {
    this.mask = data.mask;
    this.terrain = TerrainView.build(this, this.mask);

    // Boot mode flag (Authority Decision 6): networked is opt-in; hotseat is the
    // DEFAULT dev loop. `VITE_NETWORKED=1 pnpm --filter @firewallops/client dev`
    // starts networked mode.
    const flag = import.meta.env.VITE_NETWORKED;
    this.networked = flag === "1" || flag === "true";

    if (this.networked) {
      this.createNetworked();
    } else {
      this.createHotseat();
    }
  }

  // ───────────────────────────── shared scene setup ─────────────────────────────

  /** Camera bounds + keyboard/mouse input + resize/contextmenu listeners. */
  private setupCommon(): void {
    this.cameras.main.setBounds(
      0,
      -SKY_HEADROOM,
      MAP.width,
      MAP.height + SKY_HEADROOM,
    );

    const kb = this.input.keyboard;
    if (!kb) throw new Error("MatchScene requires a keyboard input plugin");
    this.cursors = kb.createCursorKeys();
    this.space = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.key1 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.key2 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.key3 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
    this.keyR = kb.addKey(Phaser.Input.Keyboard.KeyCodes.R);
    this.keyC = kb.addKey(Phaser.Input.Keyboard.KeyCodes.C);

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.phase !== "AIM") return;
      if (!p.leftButtonDown()) return;
      this.dragMode = true;
      this.dragStartX = p.x;
      this.dragStartPower = this.power;
    });
    this.input.on("pointerup", () => {
      this.dragMode = false;
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!p.rightButtonDown()) return;
      const cam = this.cameras.main;
      cam.scrollX -= p.x - p.prevPosition.x;
      cam.scrollY -= p.y - p.prevPosition.y;
      this.manualPan = true;
    });

    const onContextMenu = (e: Event) => e.preventDefault();
    this.game.canvas.addEventListener("contextmenu", onContextMenu);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this.game.canvas.removeEventListener("contextmenu", onContextMenu),
    );

    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this),
    );
  }

  // ───────────────────────────── hotseat (Phase 2 default) ─────────────────────────────

  private createHotseat(): void {
    this.buildMatch();

    this.aimView = new AimView(this);
    this.fx = new Fx(this);
    this.hud = new Hud(this, [P1_ID, P2_ID]);

    this.setupCommon();

    this.frameOnMech(this.activeMech(), false);
    this.manualPan = false;
  }

  /**
   * Build (or rebuild) the LOCAL hotseat match state, controller, mech models +
   * views. NETWORKED mode never calls this — its mechs come from syncFromState.
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
    this.mechViews[P1_ID].setHp(this.mechs[0].hp);
    this.mechViews[P2_ID].setHp(this.mechs[1].hp);
    this.mechViews[P1_ID].setBarrelAngle(this.absoluteAngle(1));
    this.mechViews[P2_ID].setBarrelAngle(this.absoluteAngle(-1));

    this.phase = "AIM";
    this.power = 0;
    this.charging = false;
    this.selectedShotId = "shot-1";
  }

  // ───────────────────────────── networked (Phase 3) ─────────────────────────────

  /**
   * Networked boot: build the cosmetic shells, wire the input, connect to the
   * Colyseus room, and let `syncFromState` drive everything. The local mechs map
   * starts empty and is populated by the first state patch (no P1/P2 seeding).
   */
  private createNetworked(): void {
    this.aimView = new AimView(this);
    this.fx = new Fx(this);
    // Up to 8 mobiles (team scope) — pre-create that many HUD turn rows.
    this.hud = new Hud(this, ["", "", "", "", "", "", "", ""]);

    this.mechViews = {};
    this.mechs = [];

    // A minimal LOCAL controller so previewTrajectory still works for the aim
    // line. Its state is unused for outcomes (server-authoritative); we inject
    // the fire sender so applyShot forwards to the net layer (seam stays live).
    const localState = createInitialState(
      [{ id: "local", x: 0, y: 0, hp: 100 }],
      [{ id: "local", facing: 1 }],
    );
    this.controller = new MatchController(this.mask, localState);

    this.setupCommon();

    this.phase = "AIM";
    this.selectedShotId = "shot-1";
    this.hud.clearIntro();

    // The bridge is the single mutation source: server shotResult → animateShot.
    const bridge = new ShotResultBridge(this);

    void connectToMatch({
      onShotResult: bridge.onShotResult,
      onTerrainSnapshot: (mask) => this.rebuildTerrain(mask),
      onMatchEnded: (winnerTeam, draw) => this.onMatchEnded(winnerTeam, draw),
      onStateChange: (s) => this.syncFromState(s as SyncedState),
    })
      .then((room) => {
        this.room = room;
        this.sessionId = room.sessionId;
        // Inject the fire sender so applyShot forwards the ABSOLUTE sim angle
        // (the server schema validates 0..180). The seam stays live: the scene
        // still calls controller.applyShot; the controller forwards here.
        this.controller.setFireSender((aim) =>
          sendFire(this.room!, aim.angleDeg, aim.power, this.selectedShotId),
        );
      })
      .catch((err: unknown) => {
        console.error("[net] failed to join match", err);
      });
  }

  /**
   * onStateChange handler (Phase 3) — the SOLE driver of turn/wind/HP/phase in
   * networked mode. Maps the server phase enum to the local input gate, drives
   * up-to-8 MechViews from the synced mobiles (team color + facing + barrel +
   * active outline), and updates the HUD. HP is NOT applied eagerly mid-shot —
   * it is stored and reconciled to the absolute on animation-land (Agreed
   * Concern #2). NO P1/P2 hardcoding — mobiles are keyed by sessionId.
   */
  private syncFromState(state: SyncedState): void {
    // Map the server enum → local gate (do NOT reuse the old local "AIM" literal).
    this.syncedPhase = state.phase;
    this.activePlayerId = state.activePlayer;
    this.syncedWind = state.wind;
    this.turnEndsAt = state.turnEndsAt;

    // Re-anchor the local countdown deadline whenever the server posts a NEW
    // turnEndsAt (a fresh turn). We assume a full TURN_MS window remains (no
    // server-time offset this phase) — drift ~RTT is acceptable.
    if (state.turnEndsAt !== this.lastTurnEndsAt) {
      this.lastTurnEndsAt = state.turnEndsAt;
      this.localTurnDeadline = this.game.getTime() + TURN_MS_LOCAL;
    }

    let activeMobile: SyncedMobile | undefined;
    const ordered: { sessionId: string; team: number; accumulatedDelay: number }[] = [];

    state.mobiles.forEach((mobile, key) => {
      const id = mobile.sessionId || key;
      this.syncedHp[id] = mobile.hp;
      this.syncedY[id] = mobile.y;
      ordered.push({
        sessionId: id,
        team: mobile.team,
        accumulatedDelay: mobile.accumulatedDelay,
      });

      // Create a MechView for a new mobile (late joiner / second tab).
      let view = this.mechViews[id];
      if (!view) {
        view = new MechView(this, mobile.x, mobile.y);
        this.mechViews[id] = view;
        view.setTeamColor(mobile.team);
        // Track a lightweight local mech record for FX float-damage anchoring.
        this.mechs.push({ id, x: mobile.x, y: mobile.y, hp: mobile.hp });
      }

      // Facing, barrel (the spectator barrel render snaps to the server's
      // ABSOLUTE angle), active outline, and team color apply EVERY patch — they
      // never move the body, so they are safe mid-animation.
      view.setFacing(mobile.facing >= 0 ? 1 : -1);
      view.setBarrelAngle(mobile.angleDeg);
      view.setActive(id === state.activePlayer);
      view.setTeamColor(mobile.team);

      const rec = this.mechs.find((m) => m.id === id);

      // Apply POSITION + HP immediately ONLY in steady state — never
      // mid-animation. A schema patch must not snap the mech to its settled spot
      // or drop its HP before the shotResult animation lands; both are
      // reconciled on land (applySettleFromState / applyHpFromState).
      if (!this.isAnimatingShot) {
        view.setPosition(mobile.x, mobile.y);
        view.setHp(mobile.hp);
        if (rec) {
          rec.x = mobile.x;
          rec.y = mobile.y;
          rec.hp = mobile.hp;
        }
      }

      if (id === state.activePlayer) activeMobile = mobile;
      if (id === this.sessionId) {
        this.localSsCharge = mobile.ssHitCharge;
        // Capture the local mobile's authoritative facing for the aim preview,
        // barrel, streamed aim, and fired shot (NET-06).
        this.localFacing = mobile.facing >= 0 ? 1 : -1;
      }
    });

    // HUD: wind, the active player's SS-charge + armed, the power meter, and the
    // N-mobile turn list (ordered by accumulatedDelay — act-next-first).
    ordered.sort((a, b) => a.accumulatedDelay - b.accumulatedDelay);
    const turnRows = ordered.map((o, i) => ({
      label: this.teamLabel(o.team, o.sessionId),
      isNext: i === 0,
    }));
    const charge = activeMobile?.ssHitCharge ?? 0;
    const armed = charge >= 3;
    this.hud.updateNetworked({
      wind: state.wind,
      ssHitCharge: charge,
      armed,
      power: this.power,
      selectedShotId: this.selectedShotId,
      turnRows,
      dtMs: 0,
    });

    // Camera: frame the ACTIVE mech at the start of each turn so BOTH players
    // watch whoever is shooting (matches the hotseat feel). After a shot the
    // camera follows the projectile into the terrain (animateShot) and stops
    // there; this re-frames on the next active mech when the turn advances.
    // A manual right-drag pan is preserved until the next turn change.
    if (this.activePlayerId && this.activePlayerId !== this.lastFramedActive) {
      const activeView = this.mechViews[this.activePlayerId];
      if (activeView) {
        const animate = this.framedOnLocal; // first frame is instant, then pan
        this.lastFramedActive = this.activePlayerId;
        this.framedOnLocal = true;
        this.manualPan = false;
        this.frameOnMech(
          { id: this.activePlayerId, x: activeView.x, y: activeView.y, hp: 0 },
          animate,
        );
      }
    }
  }

  /** A short turn-list label for a mobile: team letter + a session suffix. */
  private teamLabel(team: number, sessionId: string): string {
    const t = team === 0 ? "A" : "B";
    const me = sessionId === this.sessionId ? "*" : "";
    return `TEAM ${t}${me} ${sessionId.slice(0, 4)}`;
  }

  /**
   * The SINGLE mutation source (ShotAnimationSink contract). Runs the existing
   * animation body from the SERVER shotResult: animate the dot, carve the LOCAL
   * visual mask from `result.carves` (the server integer carves — never
   * re-rounded), repaint, FX, float damage, and reconcile HP to the synced
   * absolute on land (NOT `damage` as a delta). Sets `isAnimatingShot` so input
   * is blocked through the animation regardless of the synced phase.
   */
  animateShot(result: ShotResult): void {
    this.isAnimatingShot = true;
    this.phase = "RESOLVING";

    const totalDamage = result.damage.reduce((s, d) => s + d.amount, 0);

    const projectile = new ProjectileView(this);
    const cam = this.cameras.main;
    cam.startFollow(projectile.sprite, false, FOLLOW_LERP, FOLLOW_LERP);

    projectile.animateAlong(result.path, () => {
      cam.stopFollow();

      const impact = result.impact ?? result.path[result.path.length - 1] ?? null;

      // Carve the LOCAL visual mask from the server's integer carves verbatim
      // (NET-05) — carveCircle is a TerrainMask method, NOT a banned outcome fn.
      for (const c of result.carves) {
        this.mask.carveCircle(c.cx, c.cy, c.r);
      }
      this.terrain.repaintFromMask(this.mask);

      if (impact) {
        // blastRadius for the FX ring: use the largest carve radius as a proxy.
        const blastRadius =
          result.carves.reduce((max, c) => Math.max(max, c.r), 0) || 24;
        this.fx.explode(impact, blastRadius);
        const intensity = Math.min(0.02, totalDamage * SHAKE_PER_DAMAGE);
        this.fx.shake(MAX_SHAKE_MS, intensity);
      }

      // Floating damage numbers (result.damage positions them — NEVER HP).
      this.fx.floatDamage(result.damage, (mechId) => {
        const m = this.mechs.find((mm) => mm.id === mechId);
        return m ? { x: m.x, y: m.y } : null;
      });

      // End of animation: HP is reconciled to the synced ABSOLUTE (Agreed
      // Concern #2) — never `setHp(currentHp - damage)`. Mechs whose ground was
      // carved away settle DOWN to the synced authoritative Y (tweened).
      this.isAnimatingShot = false;
      this.applyHpFromState();
      this.applySettleFromState();

      // A terrain snapshot that arrived mid-animation is applied now (race-safe).
      if (this.pendingTerrain) {
        const mask = this.pendingTerrain;
        this.pendingTerrain = undefined;
        this.rebuildTerrain(mask);
      }
    });
  }

  /**
   * Reconcile every MechView's visual HP to the LATEST synced schema absolute
   * (the authoritative value), called when an animation lands. NEVER subtracts a
   * delta — the server hp is the truth (Agreed Concern #2 / Authority Decision 2).
   */
  private applyHpFromState(): void {
    for (const [id, view] of Object.entries(this.mechViews)) {
      const hp = this.syncedHp[id];
      if (hp === undefined) continue;
      view.setHp(hp);
      const rec = this.mechs.find((m) => m.id === id);
      if (rec) rec.hp = hp;
    }
  }

  /**
   * Reconcile every MechView's Y to the LATEST synced schema absolute when an
   * animation lands — mechs whose ground was carved away settle DOWN onto the
   * new surface. The server is the authority (it recomputed each mobile's resting
   * Y post-carve); the client only TWEENS to it (the hotseat settle feel). Mirror
   * of applyHpFromState; drop-only, so a mech never visibly rises. X is held
   * (no walking in networked mode), captured before the tween.
   */
  private applySettleFromState(): void {
    for (const [id, view] of Object.entries(this.mechViews)) {
      const targetY = this.syncedY[id];
      if (targetY === undefined) continue;
      const fromY = view.y;
      if (targetY <= fromY + 0.5) continue; // already settled (or would rise)

      const fromX = view.x;
      const proxy = { y: fromY };
      this.tweens.add({
        targets: proxy,
        y: targetY,
        duration: Phaser.Math.Clamp((targetY - fromY) * 6, 150, 600),
        ease: "Quad.easeIn",
        onUpdate: () => view.setPosition(fromX, proxy.y),
      });
      const rec = this.mechs.find((m) => m.id === id);
      if (rec) rec.y = targetY;
    }
  }

  /**
   * Rebuild the visual terrain from a decoded RLE snapshot (NET-05 / NET-06).
   * Replaces the local mask and rebuilds the TerrainView. A snapshot arriving
   * mid-animation is QUEUED (applied on land) so it never races an in-flight shot.
   */
  private rebuildTerrain(mask: TerrainMask): void {
    if (this.isAnimatingShot) {
      this.pendingTerrain = mask;
      return;
    }
    this.mask = mask;
    this.terrain.destroy();
    this.terrain = TerrainView.build(this, this.mask);
  }

  /**
   * Team-or-draw match end (Cursor MEDIUM). Deactivates ALL MechViews by
   * iterating the views map (no [P1_ID, P2_ID] loop), and shows the banner. The
   * draw case maps to the server's `endMatchDraw` (winnerTeam -1, draw true).
   * R-rematch is NOT bound in networked mode — reload/rejoin to replay (Phase 6).
   */
  private onMatchEnded(winnerTeam: number, draw: boolean): void {
    this.phase = "OVER";
    this.syncedPhase = "RESULTS";
    for (const view of Object.values(this.mechViews)) view.setActive(false);
    const text = draw ? "DRAW" : `TEAM ${winnerTeam === 0 ? "A" : "B"} WINS`;
    this.hud.showResultBanner(text);
  }

  /** Networked input gate: local + active + AIMING + not animating. */
  private isLocalActiveAndAiming(): boolean {
    return (
      this.syncedPhase === "AIMING" &&
      this.sessionId === this.activePlayerId &&
      this.sessionId !== "" &&
      !this.isAnimatingShot
    );
  }

  /** The local player's own synced mobile (for aim preview origin + facing). */
  private localMechView(): MechView | undefined {
    return this.mechViews[this.sessionId];
  }

  // ───────────────────────────── shared update ─────────────────────────────

  private onResize(gameSize: Phaser.Structs.Size): void {
    if (!this.hud) return;
    this.cameras.resize(gameSize.width, gameSize.height);
    this.hud.resize(gameSize.width, gameSize.height);
    if (this.networked) {
      const view = this.localMechView();
      if (view && this.phase !== "OVER") {
        this.frameOnMech({ id: this.sessionId, x: view.x, y: view.y, hp: 0 }, false);
        this.manualPan = false;
      }
      return;
    }
    if (this.phase !== "OVER") {
      this.frameOnMech(this.activeMech(), false);
      this.manualPan = false;
    }
  }

  update(_t: number, dtMs: number): void {
    if (this.networked) {
      this.updateNetworked(dtMs);
      return;
    }
    this.updateHotseat(dtMs);
  }

  // ───────────────────────────── networked update ─────────────────────────────

  private updateNetworked(dtMs: number): void {
    // Minimal countdown (NET-04): seconds until the local deadline anchored off
    // the server's turnEndsAt. The server is the real timeout authority; this is
    // a cosmetic readout that may drift ~RTT (CONTEXT minimal-countdown).
    if (this.room && this.syncedPhase === "AIMING") {
      const secs = (this.localTurnDeadline - this.game.getTime()) / 1000;
      this.hud.setCountdown(secs);
    } else {
      this.hud.hideCountdown();
    }

    const canInput = this.isLocalActiveAndAiming();
    const view = this.localMechView();

    if (canInput && view) {
      const dt = dtMs / 1000;

      // Angle (0-90 relative; absolute via the server-synced localFacing).
      if (this.cursors.up.isDown) {
        this.angleDeg = Math.min(90, this.angleDeg + ANGLE_RATE * dt);
      }
      if (this.cursors.down.isDown) {
        this.angleDeg = Math.max(0, this.angleDeg - ANGLE_RATE * dt);
      }

      // Power gauge: release FIRES.
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
          this.fireNetworked(view);
          return;
        }
      }

      // Mouse-drag power.
      if (this.dragMode && this.input.activePointer.isDown) {
        const delta = (this.input.activePointer.x - this.dragStartX) * DRAG_SENSITIVITY;
        this.power = Phaser.Math.Clamp(this.dragStartPower + delta, 0, 100);
      }

      // Shot select (Trojan only when the synced charge is armed). Capture the
      // prior pick so we send a selectItem to the server ONLY on an actual
      // change (NET-02) — a turn-timeout auto-fire (NET-04) then uses the current
      // pick instead of the Mobile.selectedItemId default shot-1.
      const priorShotId = this.selectedShotId;
      if (Phaser.Input.Keyboard.JustDown(this.key1)) this.selectedShotId = "shot-1";
      if (Phaser.Input.Keyboard.JustDown(this.key2)) this.selectedShotId = "shot-2";
      if (Phaser.Input.Keyboard.JustDown(this.key3)) {
        // Arming is server-validated; gate the local selection on the synced
        // SS-charge so the chip cannot be picked before it is earned.
        if (this.localSsCharge >= 3) {
          this.selectedShotId = "trojan";
        }
      }
      // Send once per real selection change (the gate-rejected trojan leaves
      // selectedShotId unchanged, so no stray send), and only after connect.
      if (this.selectedShotId !== priorShotId && this.room) {
        sendSelectItem(this.room, this.selectedShotId);
      }

      // Aim preview (local cosmetic, ONLY for the local active player). Drive the
      // local barrel + arc from the absolute angle (server-synced localFacing).
      const absAngle = this.absoluteAngle(this.localFacing);
      view.setBarrelAngle(absAngle);
      const muzzle = view.getMuzzle();
      this.aimView.drawLaunchIndicator(muzzle, absAngle, this.power, this.syncedWind);
      this.aimView.drawDevArc({
        controller: this.controller,
        mech: { id: this.sessionId, x: view.x, y: view.y, hp: 100 },
        angleDeg: absAngle,
        power: this.power,
        wind: this.syncedWind,
        gravity: GRAVITY,
        selectedShotId: this.selectedShotId,
      });

      // Throttled aim streaming (~100ms); committed=false during the hold.
      const now = this.game.getTime();
      if (now - this.lastAimSentAt >= AIM_THROTTLE_MS && this.room) {
        sendAim(this.room, absAngle, this.power, false);
        this.lastAimSentAt = now;
      }
    } else {
      // Not our turn / mid-animation: clear the local aim overlays so no ghost
      // arc shows for a spectator (opponents see barrel-angle only).
      this.aimView.clear();
    }

    // C recenter.
    if (Phaser.Input.Keyboard.JustDown(this.keyC) && view) {
      this.frameOnMech({ id: this.sessionId, x: view.x, y: view.y, hp: 0 }, true);
      this.manualPan = false;
    }
  }

  /**
   * Fire in networked mode through THE SEAM. The controller forwards (aim, def)
   * to the injected sendFire — fire-and-forget. We send `committed: true` first
   * so the server locks power precisely, then call applyShot. We do NOT animate
   * here — the broadcast `animateShot` owns the animation.
   */
  private fireNetworked(view: MechView): void {
    this.hud.clearIntro();
    const def = LOADOUT[this.selectedShotId];

    const muzzle = view.getMuzzle();
    const aim = buildShotInput({
      mech: { id: this.sessionId, x: view.x, y: view.y, hp: 100 },
      angleDeg: this.angleDeg,
      power: this.power,
      wind: this.syncedWind,
      gravity: GRAVITY,
      def,
      facing: this.localFacing,
    });
    aim.x = muzzle.x;
    aim.y = muzzle.y;

    // Commit power precisely (Agreed Concern #6) before the fire intent.
    if (this.room) sendAim(this.room, aim.angleDeg, this.power, true);

    // THE SEAM CALL — fire-and-forget to the injected net sender.
    this.controller.applyShot(aim, def);

    this.power = 0;
    this.charging = false;
    this.aimView.clear();
  }

  // ───────────────────────────── hotseat update (Phase 2, unchanged) ─────────────────────────────

  private updateHotseat(dtMs: number): void {
    const dt = dtMs / 1000;

    if (this.phase === "OVER") {
      if (Phaser.Input.Keyboard.JustDown(this.keyR)) this.rematch();
      this.hud.update(this.controller.state, this.controller, this.selectedShotId, dtMs, this.power);
      return;
    }

    if (this.phase === "RESOLVING") {
      this.hud.update(this.controller.state, this.controller, this.selectedShotId, dtMs, this.power);
      return;
    }

    const active = this.activeMech();
    const activeView = this.mechViews[active.id];
    const activePlayer = this.activePlayerState();

    if (this.cursors.up.isDown) {
      this.angleDeg = Math.min(90, this.angleDeg + ANGLE_RATE * dt);
    }
    if (this.cursors.down.isDown) {
      this.angleDeg = Math.max(0, this.angleDeg - ANGLE_RATE * dt);
    }

    if (this.cursors.left.isDown) {
      this.setActiveFacing(activePlayer, activeView, -1);
      this.tryWalk(active, activeView, -1, dt);
    }
    if (this.cursors.right.isDown) {
      this.setActiveFacing(activePlayer, activeView, 1);
      this.tryWalk(active, activeView, 1, dt);
    }

    activeView.setBarrelAngle(this.absoluteAngle(activePlayer.facing));

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
        return;
      }
    }

    if (this.dragMode && this.input.activePointer.isDown) {
      const delta = (this.input.activePointer.x - this.dragStartX) * DRAG_SENSITIVITY;
      this.power = Phaser.Math.Clamp(this.dragStartPower + delta, 0, 100);
    }

    if (Phaser.Input.Keyboard.JustDown(this.keyC)) {
      this.frameOnMech(this.activeMech(), true);
      this.manualPan = false;
    }

    if (!this.manualPan) this.keepActiveMechFramed();

    if (Phaser.Input.Keyboard.JustDown(this.key1)) this.selectedShotId = "shot-1";
    if (Phaser.Input.Keyboard.JustDown(this.key2)) this.selectedShotId = "shot-2";
    if (Phaser.Input.Keyboard.JustDown(this.key3)) {
      if (this.controller.isSSArmed(this.controller.state.activePlayerId)) {
        this.selectedShotId = "trojan";
      }
    }

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

    this.hud.update(this.controller.state, this.controller, this.selectedShotId, dtMs, this.power);
  }

  /**
   * HOTSEAT fire (Phase 2 dev loop, env-gated behind !networked).
   *
   * KNOWN LIMITATION (consequence of the Phase 3 applyShot gutting): applyShot is
   * now fire-and-forget and the hotseat controller has NO fireSender injected, so
   * the seam call is a no-op. Local outcome resolution (resolveShot/HP/carve) was
   * intentionally removed from the controller — and the scene cannot re-add it
   * (the ESLint seam guard bans the sim outcome fns in scenes/**). So the hotseat
   * dev loop now animates the local PREVIEW arc and advances the local turn
   * machine (afterImpact), but no longer carves terrain or applies damage.
   * Networked mode (VITE_NETWORKED=1) is the product path; hotseat survives as a
   * camera/aim/HUD/turn-advance dev sandbox. The seam call is preserved so the
   * structure stays identical to Phase 2.
   */
  private fire(active: Mech, activeView: MechView): void {
    this.phase = "RESOLVING";
    this.hud.clearIntro();
    this.manualPan = false;

    const def = LOADOUT[this.selectedShotId];

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

    // THE SEAM CALL (fire-and-forget; hotseat has no sender, so this is a no-op).
    this.controller.applyShot(aim, def);

    // Hotseat animates the local PREVIEW arc (the only remaining local-sim call).
    const path = this.controller.previewTrajectory(aim);

    const projectile = new ProjectileView(this);
    const cam = this.cameras.main;
    cam.startFollow(projectile.sprite, false, FOLLOW_LERP, FOLLOW_LERP);

    projectile.animateAlong(path, () => {
      cam.stopFollow();
      this.settleMechs();
      for (const m of this.mechs) {
        this.mechViews[m.id].setHp(m.hp);
      }
      this.time.delayedCall(POST_IMPACT_MS, () => this.afterImpact());
    });
  }

  /**
   * HOTSEAT-ONLY (env-gated behind !networked): advance the delay queue, reroll
   * wind, frame the next mech, check the win. DEAD in networked mode — there,
   * active player / wind / HP / terrain / phase come ONLY from syncFromState (the
   * #1 authority leak is gutted; this is never invoked in networked play).
   */
  private afterImpact(): void {
    this.manualPan = false;

    const winnerId = this.controller.checkWin();
    if (winnerId) {
      this.endMatch(winnerId);
      return;
    }

    this.controller.advanceTurn();

    const nextId = this.controller.state.activePlayerId;
    for (const id of [P1_ID, P2_ID]) {
      this.mechViews[id].setActive(id === nextId);
    }

    const nextPlayerState = this.controller.state.players.find((p) => p.id === nextId);
    if (nextPlayerState) {
      this.mechViews[nextId].setBarrelAngle(this.absoluteAngle(nextPlayerState.facing));
    }

    const nextPlayer = this.controller.state.players.find((p) => p.id === nextId);
    if (nextPlayer) nextPlayer.moveBudget = MOVE_BUDGET_PER_TURN;
    this.controller.rollWind();

    const nextMech = this.mechs.find((m) => m.id === nextId);
    if (nextMech) {
      this.frameOnMech(nextMech, true);
    }

    this.power = 0;
    this.charging = false;
    this.selectedShotId = "shot-1";
    this.phase = "AIM";
  }

  /** HOTSEAT-ONLY: last-mech-standing — freeze input + show the win banner. */
  private endMatch(winnerId: string): void {
    this.phase = "OVER";
    for (const id of [P1_ID, P2_ID]) this.mechViews[id].setActive(false);
    this.hud.showWinBanner(winnerId.toUpperCase());
  }

  /** HOTSEAT-ONLY: R rematch (non-destructive). Never bound in networked mode. */
  private rematch(): void {
    for (const id of [P1_ID, P2_ID]) {
      this.mechViews[id].destroy();
    }
    this.terrain.destroy();

    this.mask = TerrainMask.fromMap(MAP);
    this.terrain = TerrainView.build(this, this.mask);

    this.angleDeg = 45;
    this.buildMatch();
    this.hud.reset();

    const p1 = this.mechs[0];
    this.cameras.main.stopFollow();
    this.frameOnMech(p1, false);
    this.manualPan = false;
  }

  /** HOTSEAT-ONLY walk step. */
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

  /** HOTSEAT-ONLY settle. */
  private settleMechs(): void {
    for (const mech of this.mechs) {
      const surface = surfaceY(
        (x, y) => this.mask.isSolid(x, y),
        Math.round(mech.x),
        this.mask.height,
      );
      const settledY = surface - MECH_BODY_H / 2;
      if (settledY > mech.y + 0.5) {
        const view = this.mechViews[mech.id];
        const fromY = mech.y;
        mech.y = settledY;
        const proxy = { y: fromY };
        this.tweens.add({
          targets: proxy,
          y: settledY,
          duration: Phaser.Math.Clamp((settledY - fromY) * 6, 150, 600),
          ease: "Quad.easeIn",
          onUpdate: () => view.setPosition(mech.x, proxy.y),
        });
      }
    }
  }

  private activeMech(): Mech {
    const id = this.controller.state.activePlayerId;
    const m = this.mechs.find((mech) => mech.id === id);
    if (!m) throw new Error(`active mech ${id} not found`);
    return m;
  }

  /** Single source of the framing offset. */
  private frameOnMech(mech: Mech, animate: boolean): void {
    const cam = this.cameras.main;
    const targetY = mech.y + (FRAME_FRAC - 0.5) * cam.height;
    if (animate) {
      cam.pan(mech.x, targetY, PAN_MS, "Quad.easeInOut");
    } else {
      cam.centerOn(mech.x, targetY);
    }
  }

  /** HOTSEAT-ONLY auto-frame. */
  private keepActiveMechFramed(): void {
    const active = this.activeMech();
    const cam = this.cameras.main;
    const view = cam.worldView;
    const xInset = cam.width * 0.15;
    const leftBound = view.x + xInset;
    const rightBound = view.right - xInset;
    const bottomBound = view.y + (cam.height - BAR_CLEARANCE) - 24;

    if (active.x < leftBound || active.x > rightBound || active.y > bottomBound) {
      this.frameOnMech(active, true);
    }
  }

  /** HOTSEAT-ONLY: the active player's turn-economy state (holds the aim facing). */
  private activePlayerState(): PlayerState {
    const id = this.controller.state.activePlayerId;
    const p = this.controller.state.players.find((pl) => pl.id === id);
    if (!p) throw new Error(`active player ${id} not found`);
    return p;
  }

  /**
   * Convert the on-screen 0–90 relative aim into the sim's absolute angle for a
   * given facing (mirror of buildShotInput's rule). Networked mode passes the
   * local player's server-synced facing (this.localFacing); the server stores
   * the authoritative facing that drives the spectator barrel render.
   */
  private absoluteAngle(facing: 1 | -1): number {
    return facing === 1 ? this.angleDeg : 180 - this.angleDeg;
  }

  /** HOTSEAT-ONLY: set the active player's facing (on ←/→) and flip the chassis. */
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
