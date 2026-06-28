import type PhaserNamespace from "phaser";
import type { Room } from "@colyseus/sdk";
import { CloseCode } from "@colyseus/sdk";
import { getToken } from "../auth.js";
import { matchSession, convexMatchSession } from "../net/matchSession.js";
import {
  provideMatchRoom,
  sendResetRange,
  setShellFireRejectedHook,
  setShellMatchEndHook,
} from "../../net/room.js";
import type { NetHandlers } from "../../net/room.js";
import {
  provideConvexMatch,
  resetRange as convexResetRange,
  subscribeMatch as convexSubscribeMatch,
  getLiveAim,
  type ConvexNetHandlers,
} from "../../net/convexClient.js";
import { mountHudOverlay } from "../hud/hudOverlay.js";
import { bindHudToRoom } from "../hud/hudBinding.js";
import type { HudViewModel } from "../hud/hudViewModel.js";
import {
  classifyJoinError,
  RECONNECT_WINDOW_SECONDS,
  showConnectionClosed,
  showFireRejectedToast,
  showForfeited,
  showLinkRestored,
  showPostMatch,
  showReconnecting,
  showShareLinkError,
  type MatchOutcome,
  type ReconnectingOverlay,
} from "./overlays.js";

/**
 * Play page (UI-SPEC #6/#7/#9) — the THIRD split-shell page (Phase 5, Plan 09).
 *
 * It MOUNTS Phaser on `/play/:roomId` against the SINGLE matchSession connection
 * the room page already joined (Blocker 3): it reads `matchSession.current` and
 * does NOT re-join and does NOT call `leave()` on the room→play transition (that
 * swap is a render change, not a reconnect). Only a real quit / RETURN TO LOBBY
 * goes through `matchSession.leaveCurrent()`.
 *
 * Phaser lifecycle (Pitfall 5): this page creates `#game-container` + a single
 * `new Phaser.Game(GAME_CONFIG)` and `game.destroy(true)`-es it on leave, so a DOM
 * page and a live canvas never coexist and there is no double-/blank-canvas leak.
 *
 * Reconnection / disconnect (RECON-01/02): the SELF overlay (`CONNECTION LOST` +
 * the 30s countdown), the `LINK RESTORED` toast on resume, and the terminal
 * `LINK LOST — YOU FORFEITED THIS MATCH` state drive off the room's onLeave +
 * reconnection events; a hard reload of /play resumes via matchSession.reconnect
 * (the room-scoped token). The OTHERS-see-you-disconnected rendering (dim mech +
 * badge + turn-list countdown) is the synced `mobile.connected` flag in MatchScene.
 *
 * Post-match (UI-SPEC #9): the server `matchEnded` broadcast shows the win/loss/
 * draw banner → RETURN TO LOBBY → teardown + leaveCurrent + navigate("/lobby").
 */

type PhaserGame = PhaserNamespace.Game;

/**
 * VITE_DOM_HUD selects the Phase-6 DOM HUD overlay. Default ON: `"0"` is the ONLY
 * off-switch (Pitfall 5 — never test truthiness of the raw string). When OFF, the
 * overlay is never mounted and the legacy Phaser HUD shows (plan 02 threads
 * `domHud: false` to MatchScene in that case).
 */
const DOM_HUD = import.meta.env.VITE_DOM_HUD !== "0";

/**
 * Application-level keepalive interval (resilience B1). Training disables the turn
 * timer, so a thinking player generates no WS traffic; an idle socket can be closed
 * by an edge proxy (Cloudflare's ~100s idle timeout). A periodic client→server
 * `heartbeat` frame resets that idle timer. ~25s stays comfortably under 100s.
 * (Does NOT save a SUSPENDED tab — a frozen tab can't fire timers either; that case
 * is the server's longer training reconnection window + RE-ENTER RANGE.)
 */
const HEARTBEAT_INTERVAL_MS = 25_000;

/** The ONE normalized overlay contract shared with 06-03 + the binding (concern 6). */
type HudOverlay = {
  update(vm: HudViewModel, countdownText?: string): void;
  destroy(): void;
};

/** The synced shape the play page reads to resolve the local team (read-only). */
interface SyncedMobile {
  sessionId: string;
  team: number;
  /**
   * The training-range dummy is flagged `passive` by the server (Plan 02). Its
   * presence in `room.state.mobiles` is how the client detects a training room —
   * a read-only presentation gate, NOT an authority decision (threat T-08-09).
   */
  passive?: boolean;
}
interface SyncedState {
  mobiles: {
    forEach(cb: (mobile: SyncedMobile, key: string) => void): void;
  };
}

/**
 * Detect a TRAINING room from SYNCED state — the presence of a `passive` dummy
 * mobile (Plan 02). This READS `room.state` only; it registers NO Colyseus
 * listener (the listener-ownership invariant — MatchScene is the sole owner of
 * onStateChange/onMessage). It is a presentation gate, never an authority call:
 * the server gates `resetRange` itself (threat T-08-08).
 */
const isTrainingRoom = (room: Room): boolean => {
  let found = false;
  const state = room.state as unknown as SyncedState | undefined;
  state?.mobiles.forEach((m) => {
    if (m.passive === true) found = true;
  });
  return found;
};

/**
 * Render the play page into `root`. Returns a cleanup fn the router runs when
 * leaving /play (to ANY non-play route). Cleanup tears down Phaser + the
 * container + overlays but does NOT leave the match — leaving is matchSession's
 * job (Blocker 3), invoked only on RETURN TO LOBBY / a real quit.
 */
export function renderPlay(
  root: HTMLElement,
  roomId: string,
  navigate: (path: string) => void,
): () => void {
  let game: PhaserGame | null = null;
  let disposed = false;
  /** The DOM HUD overlay handle + its rAF disposer (Phase 6). Null when !DOM_HUD. */
  let overlay: HudOverlay | null = null;
  let stopHudRaf: (() => void) | null = null;
  let reconnecting: ReconnectingOverlay | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let matchOver = false;
  /**
   * Latched true once this room is confirmed TRAINING (a synced passive dummy).
   * Captured WHILE connected because a terminal close may leave room.state empty —
   * the terminal-close handler needs it to offer RE-ENTER RANGE instead of a
   * forfeit (training has no opponent/stats, so a drop is not a forfeit).
   */
  let wasTraining = false;
  /** Removers for any mounted overlay so cleanup tears them all down. */
  const overlayRemovers: Array<() => void> = [];

  const track = (remover: () => void): void => {
    overlayRemovers.push(remover);
  };

  /** Tear down Phaser + the container (Pitfall 5). NOT a match leave. */
  const teardownPhaser = (): void => {
    // Cancel the HUD rAF + destroy the overlay BEFORE the Phaser game is destroyed
    // and the container removed (Pitfall 1 idempotent, Pitfall 2 ordering). Because
    // mountPhaser calls teardownPhaser() at its top, a reconnect remount cleans the
    // previous overlay first — no leaked rAF, no double loop.
    stopHudRaf?.();
    stopHudRaf = null;
    overlay?.destroy();
    overlay = null;
    if (game) {
      game.destroy(true);
      game = null;
    }
    document.getElementById("game-container")?.remove();
  };

  const clearCountdown = (): void => {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  /** Start the resilience keepalive against `room` (clears any prior interval). */
  const startHeartbeat = (room: Room): void => {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      try {
        room.send("heartbeat", {});
      } catch {
        // Socket mid-drop — the SDK is auto-reconnecting; the next tick resumes.
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const cleanup = (): void => {
    disposed = true;
    clearCountdown();
    clearHeartbeat();
    setShellMatchEndHook(null); // detach the post-match hook so it can't fire after leave.
    setShellFireRejectedHook(null); // detach the fire-rejected hook (C1).
    reconnecting?.remove();
    reconnecting = null;
    for (const remove of overlayRemovers.splice(0)) remove();
    teardownPhaser();
  };

  /** Mount the single Phaser canvas against the (already-joined) room. */
  const mountPhaser = (room: Room): void => {
    // Destroy any prior instance first (a reconnect remounts against the resumed
    // seat) so there is never a second live Phaser.Game / canvas (Pitfall 5).
    teardownPhaser();
    root.innerHTML = "";
    const container = document.createElement("div");
    container.id = "game-container"; // GAME_CONFIG.parent === "game-container"
    container.style.width = "100vw";
    container.style.height = "100vh";
    // Pitfall 4: the overlay roots at `position:absolute; inset:0`, so the canvas
    // container must be a positioned ancestor for it to anchor to the canvas.
    container.style.position = "relative";
    root.appendChild(container);

    // BLOCKER 3: hand the ALREADY-JOINED room to the scene so MatchScene adopts
    // it (registers its listeners on the SAME seat) instead of opening a second
    // Colyseus Client. No re-join, no second seat across the room→play swap.
    provideMatchRoom(room);

    // Resilience keepalive (B1): keep the WS warm so an idle training socket isn't
    // edge-proxy-dropped. Restarted each mount; cleared on cleanup.
    startHeartbeat(room);

    // Phase 6 DOM HUD: mount the overlay over the canvas container and drive it
    // from an rAF tick that READS room.state snapshots (listener-ownership
    // invariant — bindHudToRoom registers NO Colyseus listener; MatchScene owns the
    // single one). Cancelled + destroyed in teardownPhaser BEFORE game.destroy, and
    // also registered via track() so cleanup() tears it down. Gated by VITE_DOM_HUD;
    // when OFF the overlay is not mounted and the legacy Phaser HUD shows.
    if (DOM_HUD) {
      overlay = mountHudOverlay(container);
      stopHudRaf = bindHudToRoom(room, overlay, () => disposed);
      track(() => {
        stopHudRaf?.();
        stopHudRaf = null;
        overlay?.destroy();
        overlay = null;
      });
    }

    // ── TRAINING-ROOM CONTROLS (TR-9/TR-10/TR-11) ───────────────────────────
    // Detect training client-side from SYNCED state (the presence of a `passive`
    // dummy mobile, Plan 02) — NO router change, NO second seat. CRITICAL: this is
    // a LISTENER-SAFE read. MatchScene is the SOLE owner of the room's
    // onStateChange/onMessage (Blocker 3 / room.ts:184) — a second registration
    // would CLOBBER the scene's handler — so we MIRROR bindHudToRoom: read
    // room.state from an rAF tick, register NO Colyseus listener. The cluster
    // mounts ONCE (idempotent via `trainingMounted`) when the dummy is synced;
    // a frame-budgeted rAF re-check covers the first-frame race (the dummy patch
    // may land a frame after /play mount) and self-terminates so a REAL match
    // (no passive dummy) stops polling after the budget.
    let trainingMounted = false;
    const mountTrainingClusterIfNeeded = (): boolean => {
      if (trainingMounted) return true;
      if (!isTrainingRoom(room)) return false;
      trainingMounted = true;
      wasTraining = true; // latch for the terminal-close RE-ENTER RANGE branch.

      // On-brand TRAINING label — top-left, pointer-events:none, above the canvas.
      const label = document.createElement("div");
      label.textContent = "TRAINING";
      Object.assign(label.style, {
        position: "absolute",
        top: "16px",
        left: "16px",
        zIndex: "60",
        pointerEvents: "none",
        fontFamily: "var(--font-display)",
        fontWeight: "800",
        fontSize: "13px",
        letterSpacing: "0.16em",
        color: "var(--warn)",
        textShadow: "0 0 10px rgba(245,158,11,0.45)",
      } satisfies Partial<CSSStyleDeclaration>);

      // RESET + EXIT cluster — top-right, clear of the bottom HUD action bar.
      const cluster = document.createElement("div");
      Object.assign(cluster.style, {
        position: "absolute",
        top: "14px",
        right: "16px",
        zIndex: "60",
        display: "flex",
        gap: "10px",
        alignItems: "center",
      } satisfies Partial<CSSStyleDeclaration>);

      const trainBtnStyle: Partial<CSSStyleDeclaration> = {
        padding: "9px 16px",
        background: "rgba(11,18,32,0.72)",
        color: "var(--text)",
        fontFamily: "var(--font-display)",
        fontWeight: "700",
        fontSize: "11px",
        letterSpacing: "0.08em",
        border: "1px solid rgba(95,200,245,0.3)",
        clipPath: "polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)",
        cursor: "pointer",
      };

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.textContent = "RESET RANGE (R)";
      Object.assign(resetBtn.style, trainBtnStyle);
      resetBtn.addEventListener("click", () => sendResetRange(room));

      const exitBtn = document.createElement("button");
      exitBtn.type = "button";
      exitBtn.textContent = "EXIT (ESC)";
      Object.assign(exitBtn.style, trainBtnStyle);
      exitBtn.style.color = "var(--warn)";
      exitBtn.style.borderColor = "rgba(245,158,11,0.45)";
      exitBtn.addEventListener("click", () => returnToLobby());

      cluster.append(resetBtn, exitBtn);
      container.append(label, cluster);
      track(() => {
        label.remove();
        cluster.remove();
      });

      // Training-only keybinds: R → reset, ESC → exit. Bound ONLY after a training
      // room is confirmed, so a REAL match NEVER hijacks R/ESC. preventDefault on
      // the handled keys stops browser defaults / leaks to other handlers. The
      // remover is registered via track() so cleanup tears it down (Pitfall 7 —
      // no leaked keydown, no post-leave resetRange).
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          sendResetRange(room);
        } else if (e.key === "Escape") {
          e.preventDefault();
          returnToLobby();
        }
      };
      window.addEventListener("keydown", onKey);
      track(() => window.removeEventListener("keydown", onKey));

      return true;
    };

    // Common case: the dummy IS usually synced by /play mount (training
    // startTurn() runs in onJoin before the phase flip that triggers the forward).
    if (!mountTrainingClusterIfNeeded()) {
      // First-frame race: re-check via an rAF poll that READS room.state each frame
      // (NO Colyseus listener) until the passive dummy appears (mount + stop) OR the
      // budget elapses (a REAL match never has a passive dummy — stop, never loop
      // forever). The rAF cancel is registered via track() (Pitfall 7 — no leaked rAF).
      let rafId = 0;
      let frames = 0;
      const POLL_MAX_FRAMES = 120; // ~2s at 60fps; the dummy lands within a few frames.
      const poll = (): void => {
        if (disposed) return;
        if (mountTrainingClusterIfNeeded()) return;
        if (++frames >= POLL_MAX_FRAMES) return; // give up: real match, no dummy.
        rafId = requestAnimationFrame(poll);
      };
      rafId = requestAnimationFrame(poll);
      track(() => {
        if (rafId) cancelAnimationFrame(rafId);
      });
    }

    void (async () => {
      // Dynamic import keeps Phaser off the top-level chunk — loaded ONLY on /play.
      const Phaser = (await import("phaser")).default;
      const { GAME_CONFIG } = await import("../../game-config.js");
      if (disposed) return;
      game = new Phaser.Game(GAME_CONFIG);
    })();
  };

  /** The clean RETURN TO LOBBY / quit path — THE only matchSession leave here. */
  const returnToLobby = (): void => {
    clearCountdown();
    void matchSession.leaveCurrent(); // Blocker 3: leave ONLY on a real quit.
    cleanup();
    navigate("/lobby");
  };

  // ── CONVEX ROUTE (training: plan 07; multiplayer: plan 08) ───────────────────────
  //
  // The pure-Convex play entry — used by BOTH the TRAINING route (plan 07) and the
  // MULTIPLAYER route (plan 08). On this route there is NO Colyseus `Room` — the scene
  // drives off the Convex reactive subscription (MatchScene.bindConvexMatch), so play.ts
  // only: (1) hands the matchId to the next Phaser boot via `provideConvexMatch` (the
  // Convex analog of provideMatchRoom), (2) mounts the Phaser canvas, and (3) wires the
  // EXIT control (and, for TRAINING only, the RESET RANGE control) to the Convex
  // mutations (RESET → resetRange, EXIT → leaveMatch via convexMatchSession.leaveCurrent).
  // Fire → fireShot and weapon-select → selectItem are wired in the SCENE
  // (MatchScene.bindConvexMatch — the same seam for both modes). The Colyseus heartbeat /
  // DOM-HUD-vs-room / reconnection machinery is NOT used here (Convex has no seat / no WS
  // heartbeat — the Phaser HUD shows when no room-bound DOM overlay mounts).
  //
  // TRAINING vs MULTIPLAYER is a PRESENTATION gate only (the TRAINING label + RESET
  // RANGE control). It is detected client-side from the synced `passive` dummy mobile
  // (the same read-only presentation gate as the Colyseus path — NOT an authority call;
  // the server gates resetRange itself, threat T-08-08), via a short-lived independent
  // `subscribeMatch` read that the scene's own subscription does not depend on.

  /** The clean EXIT path for the Convex route — leaveMatch + unsubscribe. */
  const exitConvexMatch = (): void => {
    void convexMatchSession.leaveCurrent(); // leaveMatch mutation + unsubscribe.
    cleanup();
    navigate("/lobby");
  };

  /**
   * Mount the Phaser canvas + controls for the Convex route (training or multiplayer).
   * EXIT (ESC / button) → leaveMatch is wired for BOTH modes. The TRAINING label +
   * RESET RANGE (R / button) cluster is mounted ONLY once a `passive` dummy is detected
   * in the synced doc (training); a real multiplayer match never mounts it.
   */
  const mountConvexMatch = (matchId: string): void => {
    teardownPhaser();
    root.innerHTML = "";
    const container = document.createElement("div");
    container.id = "game-container"; // GAME_CONFIG.parent === "game-container"
    container.style.width = "100vw";
    container.style.height = "100vh";
    container.style.position = "relative";
    root.appendChild(container);

    // Hand the matchId to the next MatchScene boot — the scene's createNetworked()
    // peeks/takes it and drives off the Convex subscription (no Colyseus room).
    provideConvexMatch(matchId);

    // ── Phase-6 DOM HUD overlay on the Convex route ─────────────────────────────
    // Mount the SAME polished DOM overlay the Colyseus path uses (gated by DOM_HUD)
    // and drive it with bindHudToRoom — but reading a Convex-backed room-like adapter
    // ({ state, sessionId }) instead of a Colyseus Room. The presence-free /
    // terrain-free `feedHandlers` subscription below keeps the adapter current; the
    // SCENE's own subscription owns the single presence heartbeat + terrain pulls, so
    // this read-only feed must not double either. `state` is the convexDocToSyncedState
    // output (a SyncedLike); `sessionId` is the caller's localMobileId.
    const hudRoom: { state: unknown; sessionId: string } = {
      state: {
        mobiles: undefined,
        phase: "",
        activePlayer: "",
        wind: 0,
        turnEndsAt: 0,
        winnerTeam: -1,
      },
      sessionId: "",
    };
    if (DOM_HUD) {
      overlay = mountHudOverlay(container);
      stopHudRaf = bindHudToRoom(hudRoom, overlay, () => disposed, (vm) => {
        // Convex doesn't stream aim, so the synced power/angle only change on fire —
        // overlay the scene's LIVE local charge onto the action bar so the power meter
        // fills as the player charges. Only while the local player is actively aiming;
        // otherwise the synced value stands (post-fire / opponent turn).
        const live = getLiveAim();
        if (!live.active || !vm.actionBar.hasLocalMobile) return vm;
        return {
          ...vm,
          actionBar: { ...vm.actionBar, power: live.power, angleDeg: live.angleDeg },
        };
      });
    }

    // EXIT cluster (top-right) — present for BOTH modes. The RESET RANGE button is
    // added to this cluster + the TRAINING label only if training is detected below.
    const cluster = document.createElement("div");
    Object.assign(cluster.style, {
      position: "absolute",
      top: "14px",
      right: "16px",
      zIndex: "60",
      display: "flex",
      gap: "10px",
      alignItems: "center",
    } satisfies Partial<CSSStyleDeclaration>);

    const trainBtnStyle: Partial<CSSStyleDeclaration> = {
      padding: "9px 16px",
      background: "rgba(11,18,32,0.72)",
      color: "var(--text)",
      fontFamily: "var(--font-display)",
      fontWeight: "700",
      fontSize: "11px",
      letterSpacing: "0.08em",
      border: "1px solid rgba(95,200,245,0.3)",
      clipPath: "polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)",
      cursor: "pointer",
    };

    const exitBtn = document.createElement("button");
    exitBtn.type = "button";
    exitBtn.textContent = "EXIT (ESC)";
    Object.assign(exitBtn.style, trainBtnStyle);
    exitBtn.style.color = "var(--warn)";
    exitBtn.style.borderColor = "rgba(245,158,11,0.45)";
    exitBtn.addEventListener("click", () => exitConvexMatch());
    cluster.append(exitBtn);
    container.append(cluster);
    track(() => cluster.remove());

    // Multiplayer keybind: ESC → exit. (Training adds R → reset below.)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitConvexMatch();
      }
    };
    window.addEventListener("keydown", onKey);
    track(() => window.removeEventListener("keydown", onKey));

    // ── TRAINING presentation gate (idempotent) ─────────────────────────────────
    // Mount the TRAINING label + RESET RANGE control once a passive dummy is synced.
    let trainingMounted = false;
    const mountTrainingChrome = (): void => {
      if (trainingMounted) return;
      trainingMounted = true;
      wasTraining = true; // latch for any terminal handling.

      const label = document.createElement("div");
      label.textContent = "TRAINING";
      Object.assign(label.style, {
        position: "absolute",
        top: "16px",
        left: "16px",
        zIndex: "60",
        pointerEvents: "none",
        fontFamily: "var(--font-display)",
        fontWeight: "800",
        fontSize: "13px",
        letterSpacing: "0.16em",
        color: "var(--warn)",
        textShadow: "0 0 10px rgba(245,158,11,0.45)",
      } satisfies Partial<CSSStyleDeclaration>);

      // RESET RANGE → the Convex `resetRange` mutation (TR-9/TR-10; server rebuilds
      // the range + respawns the dummy). Fire-and-forget; the reactive doc patch +
      // terrainVersion jump drive the wholesale rebuild back through the subscription.
      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.textContent = "RESET RANGE (R)";
      Object.assign(resetBtn.style, trainBtnStyle);
      resetBtn.addEventListener("click", () => {
        void convexResetRange(matchId).catch((err: unknown) =>
          console.error("[play] convex resetRange failed", err),
        );
      });

      // RESET goes first (left of EXIT) so EXIT stays right-most.
      cluster.insertBefore(resetBtn, exitBtn);
      container.append(label);
      track(() => {
        label.remove();
        resetBtn.remove();
      });

      // Training keybind: R → reset (ESC → exit is already bound above).
      const onTrainKey = (e: KeyboardEvent): void => {
        if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          void convexResetRange(matchId).catch((err: unknown) =>
            console.error("[play] convex resetRange failed", err),
          );
        }
      };
      window.addEventListener("keydown", onTrainKey);
      track(() => window.removeEventListener("keydown", onTrainKey));
    };

    // PERSISTENT presence-free / terrain-free subscription that BOTH (a) keeps the DOM
    // HUD adapter current (hudRoom.state/sessionId → the bindHudToRoom rAF above) and
    // (b) classifies training-vs-multiplayer ONCE (mount the TRAINING/RESET chrome on
    // the first doc carrying a passive dummy). It is a SEPARATE handle from the scene's
    // convexMatchSession subscription, so it never clobbers the scene's render path;
    // presence:false + terrain:false because the scene's subscription owns the single
    // heartbeat + terrain fetch — this read-only mirror must not double either.
    let probeDone = false;
    const feedHandlers: ConvexNetHandlers = {
      onShotResult: () => {},
      onTerrainSnapshot: () => {},
      onMatchEnded: () => {},
      onLocalIdentity: (id) => {
        hudRoom.sessionId = id; // the local seat id buildViewModel needs.
      },
      onStateChange: (s) => {
        if (disposed) return;
        hudRoom.state = s; // drives the DOM HUD (the bindHudToRoom rAF reads this).
        // Training classification (once): mount the TRAINING/RESET chrome on the first
        // doc that carries a passive dummy.
        if (probeDone) return;
        const state = s as {
          mobiles?: {
            size?: number;
            forEach(cb: (m: { passive?: boolean }) => void): void;
          };
        };
        // Wait for the first doc that actually has seats (an early/empty patch may
        // precede the roster sync).
        if (!state.mobiles || (state.mobiles.size ?? 0) === 0) return;
        let hasDummy = false;
        state.mobiles.forEach((m) => {
          if (m.passive === true) hasDummy = true;
        });
        probeDone = true;
        if (hasDummy) mountTrainingChrome();
      },
    };
    const feedUnsub = convexSubscribeMatch(matchId, feedHandlers, {
      presence: false,
      terrain: false,
    });
    track(() => feedUnsub());

    void (async () => {
      const Phaser = (await import("phaser")).default;
      const { GAME_CONFIG } = await import("../../game-config.js");
      if (disposed) return;
      game = new Phaser.Game(GAME_CONFIG);
    })();
  };

  /** Resolve the local player's match outcome from the winnerTeam + our team. */
  const resolveOutcome = (
    room: Room,
    winnerTeam: number,
    draw: boolean,
  ): { outcome: MatchOutcome; winnerLabel?: string } => {
    if (draw || winnerTeam < 0) return { outcome: "draw" };
    let myTeam = -1;
    const state = room.state as unknown as SyncedState | undefined;
    state?.mobiles.forEach((m) => {
      if (m.sessionId === room.sessionId) myTeam = m.team;
    });
    const winnerLabel = `TEAM ${winnerTeam === 0 ? "A" : "B"}`;
    return {
      outcome: myTeam === winnerTeam ? "win" : "loss",
      winnerLabel,
    };
  };

  /**
   * Show the post-match banner (idempotent — only once per match). Driven by the
   * SCENE via the shell match-end hook (the scene is the single owner of the
   * room's `matchEnded` listener — a second `onMessage("matchEnded")` here would
   * silently clobber it, since Colyseus keys onMessage by type).
   */
  const onMatchEnded = (winnerTeam: number, draw: boolean): void => {
    if (matchOver || disposed) return;
    const room = matchSession.current;
    if (!room) return;
    matchOver = true;
    clearCountdown();
    reconnecting?.remove();
    reconnecting = null;
    const { outcome, winnerLabel } = resolveOutcome(room, winnerTeam, draw);
    track(showPostMatch(outcome, returnToLobby, winnerLabel));
  };

  /**
   * Wire the SELF reconnection lifecycle off the SDK's OWN signals (the leak/spiral
   * fix). The `@colyseus/sdk` AUTO-reconnects transient drops internally (retries +
   * backoff) and exposes:
   *   - `onDrop(code)`  — a retry sequence STARTED → show the reconnecting overlay.
   *   - `onReconnect()` — a retry SUCCEEDED, the SAME Room resumed IN PLACE (the
   *     scene's listeners are still attached — no remount) → restore.
   *   - `onLeave(code)` — TERMINAL only: `CONSENTED` (our own leave / post-match —
   *     silent) or the SDK gave up (`FAILED_TO_RECONNECT` / `ABNORMAL_CLOSURE`).
   * The old code mis-read `onLeave` as a recoverable drop and spun a doomed 30s
   * resume against an already-dead seat — that spiral is gone.
   */
  const wireReconnection = (room: Room): void => {
    room.onDrop((code: number) => {
      console.warn(`[play] room.onDrop code=${code} — SDK auto-reconnecting`);
      if (disposed || matchOver) return;
      beginReconnect();
    });
    room.onReconnect(() => {
      if (disposed || matchOver) return;
      clearCountdown();
      reconnecting?.remove();
      reconnecting = null;
      track(showLinkRestored());
    });
    room.onLeave((code: number) => {
      console.warn(`[play] room.onLeave code=${code}`);
      if (disposed || matchOver) return;
      if (code === CloseCode.CONSENTED) return; // our own leave / post-match — silent.
      showTerminalClosed(code); // SDK gave up or a non-recoverable close — terminal.
    });
  };

  /**
   * Show the reconnecting overlay while the SDK retries. The countdown is a COSMETIC
   * upper bound mirroring the server's reconnection window — we do NOT drive the
   * retry (the SDK does) and we do NOT open a parallel resume. On expiry we surface
   * the terminal state (the server seat is gone by then anyway).
   */
  const beginReconnect = (): void => {
    if (reconnecting || disposed || matchOver) return;
    let remaining = RECONNECT_WINDOW_SECONDS;
    reconnecting = showReconnecting(remaining);

    clearCountdown();
    countdownTimer = setInterval(() => {
      remaining -= 1;
      reconnecting?.setRemaining(remaining);
      if (remaining <= 0) showTerminalClosed(CloseCode.FAILED_TO_RECONNECT);
    }, 1000);
  };

  /** Map a terminal WS close code to a muted diagnostic line (founder ask). */
  const closeCodeDetail = (code: number): string => {
    const label =
      code === CloseCode.FAILED_TO_RECONNECT
        ? "RECONNECT FAILED"
        : code === CloseCode.ABNORMAL_CLOSURE
          ? "CONNECTION LOST"
          : "CONNECTION CLOSED";
    return `${label} (${code})`;
  };

  /**
   * Terminal close: reconnection has definitively failed (or a non-recoverable
   * close). Tear down the overlay/countdown and show the end state. In TRAINING
   * (no opponent/stats) it is NOT a forfeit — offer RE-ENTER RANGE; otherwise the
   * forfeit banner. Idempotent via the `reconnecting`/`matchOver` guards.
   */
  const showTerminalClosed = (code: number): void => {
    if (disposed || matchOver) return;
    clearCountdown();
    reconnecting?.remove();
    reconnecting = null;
    const detail = closeCodeDetail(code);
    if (wasTraining) {
      track(showConnectionClosed(reenterRange, returnToLobby, detail));
    } else {
      track(showForfeited(returnToLobby, detail));
    }
  };

  /**
   * RE-ENTER RANGE (training resilience): tear down this dead play page and create a
   * FRESH training room, routing into it — the same flow the lobby TRAINING card
   * uses. Falls back to the lobby if the create fails.
   */
  const reenterRange = (): void => {
    cleanup();
    void (async () => {
      try {
        const token = await getToken();
        const fresh = await matchSession.create(
          "TRAINING",
          "training",
          token ?? "",
          inertHandlers(),
        );
        navigate(`/room/${fresh.roomId}`);
      } catch (err) {
        console.error("[play] re-enter range failed", err);
        navigate("/lobby");
      }
    })();
  };

  /**
   * INERT handlers for a deep-link join / room-scoped reconnect. The SCENE adopts
   * the provided room and re-registers the REAL gameplay listeners (shot / terrain
   * / state) via `attachToMatch` once Phaser boots — Colyseus keys `onMessage` by
   * type so the scene's registration supersedes these. These exist only so the
   * join/reconnect call has a handlers arg and the room-scoped reconnection token
   * is persisted; the post-match banner is driven by `setShellMatchEndHook`, NOT a
   * here-registered listener (which the scene would clobber).
   */
  const inertHandlers = (): NetHandlers => ({
    onShotResult: () => {},
    onTerrainSnapshot: () => {},
    onMatchEnded: () => {},
    onStateChange: () => {},
  });

  // The post-match banner: the scene fans match-end out to this hook (one room
  // listener, two consumers — the scene's HUD banner + this DOM banner).
  setShellMatchEndHook((winnerTeam, draw) => onMatchEnded(winnerTeam, draw));

  // fireRejected (C1): the scene fans a rejected shot out to this hook → a brief
  // DOM toast. track() removes any still-visible toast on page cleanup.
  setShellFireRejectedHook((reason) => {
    if (disposed) return;
    track(showFireRejectedToast(reason));
  });

  // ── enter /play ─────────────────────────────────────────────────────────────

  // CONVEX ROUTE (training: plan 07; multiplayer: plan 08): the lobby/room stored the
  // matchId on convexMatchSession (createRoom for training; createRoom/joinMatch for a
  // multiplayer room) before navigating to /play/:matchId. If this play page is that
  // match, drive the pure-Convex path (no Colyseus room) for BOTH modes: mount the
  // canvas + EXIT control (and the TRAINING/RESET chrome only if a passive dummy is
  // detected). The scene subscribes to the reactive doc itself via the SAME seam
  // (MatchScene.bindConvexMatch → convexMatchSession.subscribe → convexClient.subscribeMatch)
  // and owns the gameplay intents: fire → convexClient.fireShot, weapon select →
  // convexClient.selectItem (both injected in bindConvexMatch). EXIT → leaveMatch here.
  if (convexMatchSession.currentMatchId === roomId) {
    mountConvexMatch(roomId);
    return cleanup;
  }

  void (async () => {
    // BLOCKER 3: reuse the SAME connection the room page joined. If we already hold
    // this exact room, mount against it WITHOUT re-joining and WITHOUT leaving.
    if (matchSession.current && matchSession.currentRoomId === roomId) {
      const room = matchSession.current;
      wireReconnection(room);
      mountPhaser(room);
      return;
    }

    // Direct deep-link / hard reload of /play — there is no held connection. Try a
    // room-scoped resume first (a reload after a drop), else a fresh token-authed
    // join. A join rejection drops to the lobby with the classified share-link copy.
    try {
      let room = await matchSession.reconnect(roomId, inertHandlers());
      if (disposed) return;
      if (!room) {
        const token = await getToken();
        room = await matchSession.join(roomId, token ?? "", inertHandlers());
      }
      if (disposed) return;
      wireReconnection(room);
      mountPhaser(room);
    } catch (err) {
      if (disposed) return;
      console.error("[play] join failed", err);
      track(showShareLinkError(classifyJoinError(err), () => navigate("/lobby")));
    }
  })();

  return cleanup;
}
