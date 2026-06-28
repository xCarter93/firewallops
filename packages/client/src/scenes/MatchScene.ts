import Phaser from "phaser";
import { TerrainMask, AIM_WINDOW, clampRelativeAngle, aimWindowMid } from "@shared/sim";
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
import { carveDirtyXRange } from "../view/terrainDirty.js";
import { ProjectileView } from "../view/ProjectileView.js";
import { Fx } from "../view/Fx.js";
import { Hud } from "../view/Hud.js";
import type { MatchSceneData } from "./BootScene.js";
import {
  attachToMatch,
  connectToMatch,
  disposeMatchHandlers,
  notifyShellFireRejected,
  notifyShellMatchEnded,
  sendAim,
  sendFire,
  sendSelectItem,
  takeProvidedMatchRoom,
} from "../net/room.js";
import { ShotResultBridge } from "../net/shotResultBridge.js";
import {
  takeProvidedConvexMatch,
  hasProvidedConvexMatch,
  fireShot as convexFireShot,
  selectItem as convexSelectItem,
  updateAim as convexUpdateAim,
  subscribeAim as convexSubscribeAim,
  type ConvexNetHandlers,
  type AimTelegraph,
} from "../net/convexClient.js";
import { convexMatchSession } from "../shell/net/matchSession.js";
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
// --- Convex live-aim telegraph (Plan 10) ---
// The Convex `updateAim` emitter runs DELIBERATELY SLOWER than the Colyseus
// ~100ms cadence: ≤5 Hz (≥200ms) AND only when the angle moved past a coarse
// threshold (the server also coarse-quantizes to whole degrees + delta-gates the
// write). Cosmetic-only, droppable (09-RESEARCH D-01). NEVER reuse AIM_THROTTLE_MS.
const CONVEX_AIM_THROTTLE_MS = 200; // ≤5 Hz emission cap.
const CONVEX_AIM_DELTA_DEG = 1; // emit only past a ≥1° absolute-angle move.
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

// --- DOM HUD migration (Phase 6). Default ON: the string "0" is the ONLY
// off-switch (mirrors the VITE_NETWORKED parse, inverted for a default-ON flag).
// Threaded into the NETWORKED Hud only — the DOM overlay mounts from play.ts for
// a networked room, so suppressing the Phaser HUD there avoids a double-draw. The
// hotseat dev boot has no overlay and ALWAYS keeps the Phaser HUD (review concern 3).
const DOM_HUD = import.meta.env.VITE_DOM_HUD !== "0";

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
  /**
   * CF-1: the server-authoritative reconnection flag (MatchState.Mobile.connected,
   * already on the wire). The local mirror previously dropped it, so the gameplay
   * canvas could not dim a disconnected peer; carried now so syncFromState can feed
   * MechView.setConnected (dim mech + RECONNECTING badge).
   */
  connected: boolean;
  /**
   * The training-range dummy flag (Phase 8 / Plan 02). Carried on the synced shape so
   * the Convex-mapped state is assignable to what the scene reads and the training
   * detection (play.ts) sees the passive dummy. Optional — the Colyseus path may omit
   * it; the Convex mapper always supplies it (defaulting false when absent on the doc).
   */
  passive?: boolean;
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

  // Live aim state. AIM-01: opens centered at the window midpoint (= 50), not the
  // old full-band 45. The relative angle is clamped into AIM_WINDOW in both loops.
  private angleDeg = aimWindowMid();
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
  /**
   * Set on scene SHUTDOWN. The single Colyseus connection OUTLIVES the Phaser scene
   * (Blocker 3 — matchSession keeps it across /room→/play and after teardown), so a
   * late onStateChange/onMatchEnded would otherwise fire on destroyed Graphics/Text
   * and throw "Cannot read properties of null (reading 'drawImage')". Late callbacks
   * early-return on this flag.
   */
  private disposed = false;
  private room?: Room;
  /**
   * [Convex training, plan 07] The matchId the scene is driving off the Convex
   * subscription, or `undefined` on the Colyseus path. When set, fire routes through
   * the `convexFireShot` mutation (no `this.room`), and the live subscription disposer
   * (`convexUnsub`) is torn down on SHUTDOWN. Only the TRAINING route sets this for
   * now (the multiplayer routes flip in plan 08).
   */
  private convexMatchId?: string;
  /**
   * [Plan 10] The live opponent-aim telegraph disposer (`subscribeAim`), torn down
   * on scene SHUTDOWN alongside the match subscription. Cosmetic-only.
   */
  private convexAimUnsub?: () => void;
  /**
   * The LOCAL player's own seat id used for ALL input gating
   * (`isLocalActiveAndAiming`, the per-mobile `id === this.sessionId` branches in
   * syncFromState, the local MechView lookup). Named `sessionId` for historical
   * Colyseus reasons, but in the pure-Convex path (plan 06, review [I]) its SOURCE
   * is the Convex `localMobileId` (`api.match.get`'s caller-only seat id) — set via
   * `setLocalMobileId()`, the replacement for the Colyseus `room.sessionId`
   * assignment (accountId never crosses the wire). The `=== activePlayerId` /
   * `id === sessionId` comparisons keep working unchanged in shape.
   */
  private sessionId = "";
  /**
   * [I] The Convex caller-seat id surfaced by convexClient (`onLocalIdentity`). Kept
   * as a distinct field so a late/duplicate identity push is idempotent and the
   * source of `this.sessionId` is explicit. Mirrors `sessionId` in the Convex path.
   */
  private localMobileId = "";
  private syncedPhase = "WAITING";
  private activePlayerId = "";
  private isAnimatingShot = false;
  private lastAimSentAt = 0;
  /**
   * [Convex live-aim, plan 10] The last ABSOLUTE angle EMITTED to the Convex
   * `updateAim` telegraph, for the client-side delta-gate (emit only when the aim
   * moved past CONVEX_AIM_DELTA_DEG). -Infinity forces the first emit. Distinct
   * from `lastAimSentAt` (which the Colyseus path also uses for its ~100ms cadence)
   * because the Convex emitter runs at a SLOWER ≤5 Hz cadence + a delta gate.
   */
  private lastAimSentAngle = Number.NEGATIVE_INFINITY;
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
  // Authoritative countdown via a server-clock offset: game-time + serverClockOffset
  // ≈ server clock. Recalibrated at each fresh turn (turnEndsAt changes, > 0). The
  // countdown reads `turnEndsAt - serverNow`, so it resets per turn and survives an
  // in-place reconnect. Training (turnEndsAt === 0) shows no countdown.
  private serverClockOffset = 0;
  private offsetTurnEndsAt = -1;
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
    // starts networked mode. The Convex TRAINING route (plan 07) also takes the
    // networked path even with VITE_NETWORKED off — the play page provides a Convex
    // matchId (peeked here, NOT consumed; createNetworked takes it) so the scene
    // drives off the Convex subscription instead of a Colyseus room.
    const flag = import.meta.env.VITE_NETWORKED;
    this.networked =
      flag === "1" || flag === "true" || hasProvidedConvexMatch();

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

    // Blocker 3: the room connection survives this scene. Mark disposed on SHUTDOWN
    // so any in-flight Colyseus patch/broadcast that arrives after teardown is
    // ignored instead of drawing into destroyed Phaser objects (drawImage-null) —
    // AND remove this scene's room listeners so a remount never fires them again
    // (the listener-leak fix: the SDK APPENDS, so a re-attach without removal stacks
    // duplicate handlers on the surviving Room). disposeMatchHandlers is a no-op in
    // hotseat (no room). CRITICAL: disposal is bound to SHUTDOWN ONLY — an in-place
    // SDK reconnect (onReconnect in play.ts) does NOT shut the scene down, so the
    // resumed scene keeps its listeners.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.disposed = true;
      if (this.room) disposeMatchHandlers(this.room);
    });
  }

  // ───────────────────────────── hotseat (Phase 2 default) ─────────────────────────────

  private createHotseat(): void {
    this.buildMatch();

    this.aimView = new AimView(this);
    this.fx = new Fx(this);
    // Hotseat ALWAYS keeps the Phaser HUD: the DOM overlay only mounts for a
    // networked room (play.ts), so suppressing here would leave the dev loop with
    // no HUD at all. domHud is hard-false regardless of VITE_DOM_HUD (concern 3).
    this.hud = new Hud(this, [P1_ID, P2_ID], { domHud: false });

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

    // Resolve the route BEFORE building the HUD. A provided Convex matchId means the
    // state source is the Convex subscription and play.ts mounts NO DOM HUD overlay
    // (that overlay is Colyseus-room-bound). So on the Convex route the Phaser HUD
    // MUST render (domHud:false) — otherwise BOTH HUDs are suppressed and nothing
    // (wind / power / turn list) shows. The Colyseus path keeps the DOM overlay +
    // the suppressed Phaser HUD (DOM_HUD default ON; VITE_DOM_HUD=0 forces Phaser).
    const providedConvexMatchId = takeProvidedConvexMatch();

    // Up to 8 mobiles (team scope) — pre-create that many HUD turn rows.
    this.hud = new Hud(this, ["", "", "", "", "", "", "", ""], {
      domHud: providedConvexMatchId ? false : DOM_HUD,
    });

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

    const handlers = {
      onShotResult: bridge.onShotResult,
      onTerrainSnapshot: (mask: TerrainMask) => this.rebuildTerrain(mask),
      onMatchEnded: (winnerTeam: number, draw: boolean) =>
        this.onMatchEnded(winnerTeam, draw),
      onStateChange: (s: unknown) => this.syncFromState(s as SyncedState),
      // fireRejected → fan out to the shell's DOM toast (the scene owns the single
      // onMessage listener; the shell renders the notice).
      onFireRejected: (reason: string) => notifyShellFireRejected(reason),
    };

    // ── CONVEX TRAINING ROUTE (plan 07) ──────────────────────────────────────────
    // If the play page provided a Convex matchId (training only for now), the scene's
    // SOURCE of state is the Convex reactive subscription, NOT a Colyseus room. The
    // handlers above are the SAME contract — onStateChange/onShotResult/onTerrainSnapshot
    // /onMatchEnded drive the UNCHANGED render path; we only add onLocalIdentity (the
    // Convex `localMobileId` → setLocalMobileId, [I], the replacement for room.sessionId)
    // and route the fire seam through the `fireShot` mutation (no `this.room`). All the
    // `if (this.room)` aim/select sends below harmlessly no-op (room is undefined) — the
    // Convex `fireShot` mutation carries the committed angle/power/itemId, so the server
    // re-derives the outcome with no streamed aim. Return early so the Colyseus
    // adopt/connect path is never entered on the training route.
    if (providedConvexMatchId) {
      this.bindConvexMatch(providedConvexMatchId, handlers);
      return;
    }

    // Bind the controller's fire sender once we hold the room (shared by both the
    // adopted-room handoff and the standalone connect path). The seam stays live:
    // the scene still calls controller.applyShot; the controller forwards here
    // with the ABSOLUTE sim angle (the server schema validates 0..180).
    const bindRoom = (room: Room): void => {
      this.room = room;
      this.sessionId = room.sessionId;
      this.controller.setFireSender((aim) =>
        sendFire(this.room!, aim.angleDeg, aim.power, this.selectedShotId),
      );
    };

    // BLOCKER 3: prefer the room the SHELL already joined (provided via the play
    // page from matchSession.current). Adopting it registers the scene's listeners
    // on the SAME seat — no second Colyseus Client, no second seat. Only a
    // standalone VITE_NETWORKED dev boot (no shell, no provided room) falls through
    // to connectToMatch (which opens its own connection — dev-only).
    const adopted = takeProvidedMatchRoom();
    if (adopted) {
      bindRoom(attachToMatch(adopted, handlers));
      // The adopted room's schema is ALREADY synced (from the staging room), and
      // Colyseus onStateChange fires only on the NEXT patch — so without an explicit
      // initial sync the adopting client (the room CREATOR) renders no mechs and
      // never sets its input gate, so it misses turn 1 and gets auto-forfeited. Mirror
      // room.ts's post-join immediate render. syncFromState guards the unsynced shape.
      this.syncFromState(adopted.state as SyncedState);
    } else {
      void connectToMatch(handlers)
        .then(bindRoom)
        .catch((err: unknown) => {
          console.error("[net] failed to join match", err);
        });
    }
  }

  /**
   * [Convex training, plan 07] Drive the scene off the Convex reactive subscription
   * instead of a Colyseus room. This is the Convex analog of `bindRoom` + the adopt
   * branch: it subscribes (via the single-owner `convexMatchSession`) with the SAME
   * NetHandlers — extended with `onLocalIdentity` (the caller's `localMobileId` →
   * `setLocalMobileId`, [I]) — and injects the fire seam so `controller.applyShot`
   * forwards to the `fireShot` mutation. The subscription disposer is torn down on
   * scene SHUTDOWN (the connection does NOT outlive the scene on the Convex path —
   * there is no seat; `convexMatchSession` re-subscribes on a fresh mount). The render
   * mechanism (syncFromState/animateShot/terrain) is UNCHANGED — only the SOURCE moved.
   */
  private bindConvexMatch(
    matchId: string,
    handlers: ConvexNetHandlers,
  ): void {
    this.convexMatchId = matchId;

    // The fire seam → the Convex `fireShot` mutation (fire-and-forget; the server
    // re-derives every outcome, plan 05). The committed ABSOLUTE angle + power +
    // selected item ride the mutation — no streamed aim is needed (the Colyseus
    // `sendAim`/`sendSelectItem` calls in updateNetworked/fireNetworked are
    // `if (this.room)`-guarded, so they no-op on this path).
    this.controller.setFireSender((aim) => {
      void convexFireShot(
        matchId,
        aim.angleDeg,
        aim.power,
        this.selectedShotId,
      ).catch((err: unknown) => {
        console.error("[convex] fireShot failed", err);
      });
    });

    // Subscribe with the SAME handlers + the Convex-only onLocalIdentity seam ([I]).
    convexMatchSession.subscribe(matchId, {
      ...handlers,
      onLocalIdentity: (localMobileId: string) =>
        this.setLocalMobileId(localMobileId),
    });

    // [Plan 10] OPPONENT-AIM TELEGRAPH (cosmetic-only). With the Colyseus aim
    // stream gone, the synced `matches` doc only carries an opponent's angle on a
    // FIRE — so the opponent barrel would otherwise sit frozen between turns. Feed
    // the live `matchAim` telegraph into the EXISTING interpolation callsite
    // (`setBarrelAngleTarget`, the same one syncFromState drives for spectated
    // mechs) so the opponent barrel glides to the telegraphed angle. We SKIP our
    // own seat (the local barrel is driven from local input) so an echo of our own
    // aim never fights the immediate local render. NEVER gates fire (authority
    // reads only fireShot's payload); dropping this leaves the loop untouched.
    this.convexAimUnsub = convexSubscribeAim(
      matchId,
      (aim: AimTelegraph | null) => {
        if (this.disposed || !aim) return;
        if (aim.mobileId === this.sessionId) return; // our own aim — local render owns it.
        this.mechViews[aim.mobileId]?.setBarrelAngleTarget(aim.angleDeg);
      },
    );

    // Drop the live subscription when the scene shuts down (the Convex analog of the
    // Colyseus disposeMatchHandlers — no seat to keep, so unsubscribe and stop the
    // reactive feed; a fresh /play mount re-subscribes). This does NOT call
    // `leaveMatch` — leaving is the EXIT control's job (play.ts → leaveCurrent).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      convexMatchSession.unsubscribe();
      // Tear down the cosmetic aim telegraph alongside the match subscription.
      this.convexAimUnsub?.();
      this.convexAimUnsub = undefined;
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
    // Late patch after teardown → the scene's Phaser objects are destroyed (Blocker 3
    // keeps the connection alive past SHUTDOWN). Ignore it (drawImage-null guard).
    if (this.disposed) return;
    // `mobiles` (MapSchema) is undefined until the first patch decodes. The immediate
    // adopt-sync (createNetworked) can pass an unsynced state on a true cold join;
    // bail until it exists — the next onStateChange patch re-syncs.
    if (!state.mobiles) return;
    // Map the server enum → local gate (do NOT reuse the old local "AIM" literal).
    this.syncedPhase = state.phase;
    this.activePlayerId = state.activePlayer;
    this.syncedWind = state.wind;
    this.turnEndsAt = state.turnEndsAt;

    // Calibrate the server-clock offset at each fresh turn (turnEndsAt changes to a
    // positive value): at turn start the server set turnEndsAt = serverNow + TURN_MS,
    // and this patch lands ~one-way-latency later, so serverNow ≈ turnEndsAt -
    // TURN_MS_LOCAL here. Training sends turnEndsAt === 0 (no timer) — skip (the
    // display gate below hides the countdown there).
    if (state.turnEndsAt > 0 && state.turnEndsAt !== this.offsetTurnEndsAt) {
      this.offsetTurnEndsAt = state.turnEndsAt;
      this.serverClockOffset =
        state.turnEndsAt - TURN_MS_LOCAL - this.game.getTime();
    }

    let activeMobile: SyncedMobile | undefined;
    const ordered: { sessionId: string; team: number; accumulatedDelay: number }[] = [];
    // M6: the set of sessionIds PRESENT in this synced patch. Any MechView whose id
    // is absent is a ghost (a forfeited/removed mobile, server-side removeAndForfeit)
    // and is destroyed after the loop.
    const present = new Set<string>();

    state.mobiles.forEach((mobile, key) => {
      const id = mobile.sessionId || key;
      present.add(id);
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
        // Snap the barrel to its initial synced angle so a fresh spectated mech
        // does not sweep from the default (interpolation starts from here).
        view.setBarrelAngle(mobile.angleDeg);
        // Track a lightweight local mech record for FX float-damage anchoring.
        this.mechs.push({ id, x: mobile.x, y: mobile.y, hp: mobile.hp });
      }

      // Facing, barrel, active outline, and team color apply EVERY patch — they
      // never move the body, so they are safe mid-animation. The LOCAL player's
      // barrel is driven immediately from local input in updateNetworked, so we
      // snap it here; a spectated (non-local) barrel is set as an interpolation
      // TARGET and eased per-frame (interpolateBarrel) to remove the 20Hz snap.
      view.setFacing(mobile.facing >= 0 ? 1 : -1);
      if (id === this.sessionId) {
        view.setBarrelAngle(mobile.angleDeg);
      } else {
        view.setBarrelAngleTarget(mobile.angleDeg);
      }
      view.setActive(id === state.activePlayer);
      view.setTeamColor(mobile.team);
      // CF-1: surface the synced peer-disconnect state on the canvas (dim mech +
      // RECONNECTING badge). Treat a missing value as connected (the field is on
      // the wire but defaults true). Safe every patch — it only toggles
      // alpha/visibility and re-anchors the badge, never moves the body.
      view.setConnected(mobile.connected !== false);

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

    // M6 (stale-view removal): destroy + drop any MechView whose sessionId is no
    // longer in the synced state (the server's removeAndForfeit deleted the mobile).
    // Absence from synced state is AUTHORITATIVE — the server only deletes a mobile
    // on a real removal, never on a transient patch, so the local player's own view
    // is never dropped while it is still seated. Paired with Task 2's server-side
    // removeAndForfeit so a forfeited mech leaves no ghost sprite.
    for (const id of Object.keys(this.mechViews)) {
      if (!present.has(id)) {
        this.mechViews[id].destroy();
        delete this.mechViews[id];
        this.mechs = this.mechs.filter((m) => m.id !== id);
        delete this.syncedHp[id];
        delete this.syncedY[id];
      }
    }

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
    // A shotResult broadcast arriving after teardown would build a ProjectileView
    // against a destroyed scene (`this.add` is null → "Cannot read properties of
    // null (reading 'add')"). The connection outlives the scene (Blocker 3), so
    // ignore late shots — same guard as syncFromState/onMatchEnded.
    if (this.disposed) return;
    this.isAnimatingShot = true;
    this.phase = "RESOLVING";

    const totalDamage = result.damage.reduce((s, d) => s + d.amount, 0);

    const projectile = new ProjectileView(this);
    const cam = this.cameras.main;
    cam.startFollow(projectile.sprite, false, FOLLOW_LERP, FOLLOW_LERP);

    projectile.animateAlong(result.path, () => {
      // The scene can be torn down DURING the projectile flight (an idle WS drop +
      // reconnect remount mid-shot). The land callback touches terrain/fx/views, so
      // bail if the scene is gone rather than draw into destroyed Phaser objects.
      if (this.disposed) return;
      cam.stopFollow();

      const impact = result.impact ?? result.path[result.path.length - 1] ?? null;

      // Carve the LOCAL visual mask from the server's integer carves verbatim
      // (NET-05) — carveCircle is a TerrainMask method, NOT a banned outcome fn.
      for (const c of result.carves) {
        this.mask.carveCircle(c.cx, c.cy, c.r);
      }
      // Repaint ONLY the columns the carves can touch (cx±r) — a full-field
      // repaint per shot is an O(width·height) hitch on every impact. Falls back
      // to a full repaint if the band can't be computed (no carves).
      const dirty = carveDirtyXRange(result.carves, this.mask.width);
      this.terrain.repaintFromMask(this.mask, dirty ?? undefined);

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
    // A terrainSnapshot can land after teardown (training rebroadcasts terrain on
    // every reset/respawn, and a reconnect re-sends it). Destroying/rebuilding the
    // TerrainView on a torn-down scene throws — ignore it (Blocker 3).
    if (this.disposed) return;
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
    // A matchEnded broadcast arriving after teardown would draw the banner into a
    // destroyed HUD (drawImage-null). Ignore once the scene is gone (Blocker 3).
    if (this.disposed) return;
    this.phase = "OVER";
    this.syncedPhase = "RESULTS";
    for (const view of Object.values(this.mechViews)) view.setActive(false);
    const text = draw ? "DRAW" : `TEAM ${winnerTeam === 0 ? "A" : "B"} WINS`;
    this.hud.showResultBanner(text);
    // Fan the match-end out to the shell so the play page can render the UI-SPEC
    // post-match banner (RETURN TO LOBBY). The scene stays the SINGLE owner of the
    // room listeners (Blocker 3) — the shell consumes via this hook, not a second
    // onMessage("matchEnded") that would clobber this handler.
    notifyShellMatchEnded(winnerTeam, draw);
  }

  /**
   * [I] Set the LOCAL seat id from the Convex `localMobileId` (the convexClient
   * `onLocalIdentity` callback). This REPLACES the Colyseus `this.sessionId =
   * room.sessionId` assignment (createNetworked/bindRoom) as the SOURCE of the local
   * id — `accountId` never crosses the wire, so `api.match.get`'s caller-only
   * `localMobileId` is the only place the client learns its own seat. All input
   * gating (`isLocalActiveAndAiming`, the `id === this.sessionId` branches) keeps
   * working unchanged in shape. Idempotent — a duplicate identity push is a no-op.
   */
  public setLocalMobileId(localMobileId: string): void {
    if (this.disposed || !localMobileId) return;
    this.localMobileId = localMobileId;
    this.sessionId = localMobileId;
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
    if (this.room && this.syncedPhase === "AIMING" && this.turnEndsAt > 0) {
      const serverNow = this.game.getTime() + this.serverClockOffset;
      const secs = (this.turnEndsAt - serverNow) / 1000;
      this.hud.setCountdown(secs);
    } else {
      this.hud.hideCountdown();
    }

    // Entity interpolation: ease every SPECTATED (non-local) barrel toward its
    // latest synced angle each frame, so an opponent's aim glides instead of
    // stepping at the ~20Hz patch rate. The local mech's barrel is driven from
    // local input below (immediate), so it is skipped here.
    for (const id of Object.keys(this.mechViews)) {
      if (id === this.sessionId) continue;
      this.mechViews[id].interpolateBarrel(dtMs);
    }

    const canInput = this.isLocalActiveAndAiming();
    const view = this.localMechView();

    if (canInput && view) {
      const dt = dtMs / 1000;

      // Angle (relative, clamped into AIM_WINDOW; absolute via the server-synced
      // localFacing). AIM-01: the control side clamp mirrors the authoritative
      // server clamp — the server is still the sole authority.
      if (this.cursors.up.isDown) {
        this.angleDeg = clampRelativeAngle(this.angleDeg + ANGLE_RATE * dt);
      }
      if (this.cursors.down.isDown) {
        this.angleDeg = clampRelativeAngle(this.angleDeg - ANGLE_RATE * dt);
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
      // selectedShotId unchanged, so no stray send), and only after connect. On the
      // Convex path (no this.room) route the same NET-02 intent through the
      // `selectItem` mutation so a multiplayer weapon switch reaches the authority
      // (plan 08); the Colyseus path keeps sendSelectItem.
      if (this.selectedShotId !== priorShotId) {
        if (this.room) {
          sendSelectItem(this.room, this.selectedShotId);
        } else if (this.convexMatchId) {
          void convexSelectItem(this.convexMatchId, this.selectedShotId).catch(
            (err: unknown) =>
              console.error("[convex] selectItem failed", err),
          );
        }
      }

      // Aim preview (local cosmetic, ONLY for the local active player). Drive the
      // local barrel + arc from the absolute angle (server-synced localFacing).
      const absAngle = this.absoluteAngle(this.localFacing);
      view.setBarrelAngle(absAngle);
      const muzzle = view.getMuzzle();
      this.aimView.drawLaunchIndicator(muzzle, absAngle, this.power, this.syncedWind);
      // AIM-01: render the allowed window arc at the muzzle for the local active player.
      this.aimView.drawAimWindow(muzzle, this.localFacing, AIM_WINDOW);
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

      // [Plan 10] Convex opponent-aim telegraph (cosmetic-only). On the pure-Convex
      // path (no this.room) emit the LOCAL active player's absolute angle through
      // the throttled `updateAim` mutation — DELIBERATELY SLOWER than the Colyseus
      // cadence: ≤5 Hz (≥200ms) AND only when the angle moved past CONVEX_AIM_DELTA_DEG
      // (≥1°). The server also coarse-quantizes + delta-gates the write, so a held
      // aim costs zero writes (T-09-20). Fire-and-forget; it NEVER gates fire.
      if (
        this.convexMatchId &&
        now - this.lastAimSentAt >= CONVEX_AIM_THROTTLE_MS &&
        Math.abs(absAngle - this.lastAimSentAngle) >= CONVEX_AIM_DELTA_DEG
      ) {
        this.lastAimSentAt = now;
        this.lastAimSentAngle = absAngle;
        void convexUpdateAim(this.convexMatchId, absAngle).catch(
          (err: unknown) => console.error("[convex] updateAim failed", err),
        );
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
    // [H] Out-of-turn / wrong-phase fire UX (preserved). The Colyseus server used to
    // reply `fireRejected` for a fire it refused; the Convex `fireShot` instead
    // SILENTLY no-ops out-of-turn (plan 05). So the rejection trigger moves
    // client-side: pre-check the local-active-AIMING gate here and, when NOT allowed,
    // invoke the SAME `notifyShellFireRejected(reason)` fan-out the play page renders
    // as a toast — instead of sending a no-op mutation. The render is UNCHANGED; only
    // the trigger source moved. (Reasons mirror the old server fireRejected copy.)
    if (!this.isLocalActiveAndAiming()) {
      const reason =
        this.sessionId !== this.activePlayerId
          ? "Not your turn"
          : this.syncedPhase !== "AIMING"
            ? "Cannot fire right now"
            : "rejected";
      notifyShellFireRejected(reason);
      return;
    }

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

    // AIM-01: relative aim clamped into AIM_WINDOW (matches the networked loop).
    if (this.cursors.up.isDown) {
      this.angleDeg = clampRelativeAngle(this.angleDeg + ANGLE_RATE * dt);
    }
    if (this.cursors.down.isDown) {
      this.angleDeg = clampRelativeAngle(this.angleDeg - ANGLE_RATE * dt);
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
    // AIM-01: window arc gauge at the muzzle for the active hotseat player.
    this.aimView.drawAimWindow(muzzle, activePlayer.facing as 1 | -1, AIM_WINDOW);
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

    this.angleDeg = aimWindowMid(); // AIM-01: rematch reopens centered in-window.
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
