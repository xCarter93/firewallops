import type PhaserNamespace from "phaser";
import { convexMatchSession } from "../net/matchSession.js";
import {
  provideConvexMatch,
  resetRange as convexResetRange,
  subscribeMatch as convexSubscribeMatch,
  getLiveAim,
  getShotHold,
  setShellFireRejectedHook,
  type ConvexNetHandlers,
} from "../../net/convexClient.js";
import { mountHudOverlay } from "../hud/hudOverlay.js";
import { bindHudToRoom } from "../hud/hudBinding.js";
import type { HudViewModel, SyncedLike } from "../hud/hudViewModel.js";
import { showFireRejectedToast, showPostMatch, type MatchOutcome } from "./overlays.js";

/**
 * Play page (UI-SPEC #6/#7/#9) — the THIRD split-shell page (Phase 5/9), pure Convex.
 *
 * It MOUNTS Phaser on `/play/:roomId` against the Convex reactive subscription: it
 * hands the matchId to the scene via `provideConvexMatch` (the scene then drives off
 * `convexMatchSession.subscribe`), wires the EXIT control (and, for TRAINING, RESET
 * RANGE) to the Convex mutations, and feeds the DOM HUD overlay. Leaving (EXIT) goes
 * through `convexMatchSession.leaveCurrent()` (the `leaveMatch` mutation).
 *
 * Phaser lifecycle (Pitfall 5): this page creates `#game-container` + a single
 * `new Phaser.Game(GAME_CONFIG)` and `game.destroy(true)`-es it on leave, so a DOM
 * page and a live canvas never coexist and there is no double-/blank-canvas leak.
 *
 * Disconnect rendering (the dim mech + AWAY badge) is the synced `mobile.connected`
 * flag in MatchScene (presence-driven). Match end shows the scene's "TEAM X WINS"
 * result banner; EXIT returns to the lobby.
 */

type PhaserGame = PhaserNamespace.Game;

/**
 * VITE_DOM_HUD selects the Phase-6 DOM HUD overlay. Default ON: `"0"` is the ONLY
 * off-switch (Pitfall 5 — never test truthiness of the raw string). When OFF, the
 * overlay is never mounted and the legacy Phaser HUD shows (plan 02 threads
 * `domHud: false` to MatchScene in that case).
 */
const DOM_HUD = import.meta.env.VITE_DOM_HUD !== "0";

/** The ONE normalized overlay contract shared with 06-03 + the binding (concern 6). */
type HudOverlay = {
  update(vm: HudViewModel, countdownText?: string): void;
  destroy(): void;
};

/**
 * Resolve the LOCAL player's match outcome (Area C — re-added helper, NOT new
 * architecture; mirrors hudViewModel's local-mobile-by-sessionId lookup at
 * :261-266). `winnerTeam`/`draw` come straight off the Convex RESULTS doc; the
 * local player's team is read from `state.mobiles` matched against `localSeat`
 * (the local seat id), so a win/loss is resolved per-seat rather than from
 * `winnerTeam` alone. Typed against `SyncedLike` (the convexDocToSyncedState
 * output) so the call site casts `hudRoom.state as SyncedLike` — no `as never`.
 */
function resolveOutcome(
  state: SyncedLike,
  localSeat: string,
  winnerTeam: number,
  draw: boolean,
): { outcome: MatchOutcome; winnerLabel: string } {
  if (draw || winnerTeam < 0) return { outcome: "draw", winnerLabel: "" };

  let localTeam: number | undefined;
  state.mobiles?.forEach((m, key) => {
    const id = m.sessionId || key; // id-normalization identical to hudViewModel:262.
    if (id === localSeat) localTeam = m.team;
  });

  const winnerLabel = winnerTeam === 0 ? "TEAM A" : "TEAM B";
  const outcome: MatchOutcome = localTeam === winnerTeam ? "win" : "loss";
  return { outcome, winnerLabel };
}

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
  /** Removers for any mounted overlay so cleanup tears them all down. */
  const overlayRemovers: Array<() => void> = [];

  const track = (remover: () => void): void => {
    overlayRemovers.push(remover);
  };

  /** Tear down Phaser + the container (Pitfall 5). NOT a match leave. */
  const teardownPhaser = (): void => {
    // Cancel the HUD rAF + destroy the overlay BEFORE the Phaser game is destroyed
    // and the container removed (Pitfall 1 idempotent, Pitfall 2 ordering).
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

  const cleanup = (): void => {
    disposed = true;
    setShellFireRejectedHook(null); // detach the fire-rejected hook (C1).
    for (const remove of overlayRemovers.splice(0)) remove();
    teardownPhaser();
  };

  // ── CONVEX ROUTE (training: plan 07; multiplayer: plan 08) ───────────────────────
  //
  // The play entry for BOTH modes. The scene drives off the Convex reactive
  // subscription (MatchScene.bindConvexMatch); play.ts only (1) hands the matchId to
  // the next Phaser boot via `provideConvexMatch`, (2) mounts the canvas, and (3) wires
  // EXIT (and, for TRAINING, RESET RANGE) to the Convex mutations (RESET → resetRange,
  // EXIT → leaveMatch via convexMatchSession.leaveCurrent). Fire → fireShot and
  // weapon-select → selectItem are wired in the SCENE.
  //
  // TRAINING vs MULTIPLAYER is a PRESENTATION gate only (the TRAINING label + RESET
  // RANGE control), detected client-side from the synced `passive` dummy mobile (NOT
  // an authority call — the server gates resetRange itself, threat T-08-08), via the
  // read-only `feedHandlers` subscription below.

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
    /** Fire-once guard for the DOM post-match overlay (HD-03; pairs with disposed). */
    let shownPostMatch = false;
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
        let out = vm;
        // SHOT-HOLD: Convex resolves a shot in one doc write, so the reduced HP lands
        // in the SAME patch as the shot — the scene defers the canvas HP-bar drop until
        // the projectile lands, so hold the turn-row HP at the pre-shot snapshot too
        // (otherwise the HUD's HP number drops the instant you fire). Cleared on land.
        const hold = getShotHold();
        if (hold.active) {
          out = {
            ...out,
            turnRows: out.turnRows.map((r) => {
              const held = hold.hp[r.id];
              if (held === undefined) return r;
              return { ...r, hp: held, eliminated: held <= 0 };
            }),
          };
        }
        // Convex doesn't stream aim, so the synced power/angle only change on fire —
        // overlay the scene's LIVE local charge onto the action bar so the power meter
        // fills as the player charges. Only while the local player is actively aiming;
        // otherwise the synced value stands (post-fire / opponent turn).
        const live = getLiveAim();
        if (live.active && out.actionBar.hasLocalMobile) {
          out = {
            ...out,
            actionBar: { ...out.actionBar, power: live.power, angleDeg: live.angleDeg },
          };
        }
        return out;
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
      onMatchEnded: (winnerTeam, draw) => {
        // Mutually exclusive with the in-canvas banner: the DOM overlay fires ONLY
        // when DOM_HUD (legacy VITE_DOM_HUD=0 keeps the scene's showResultBanner as
        // the sole surface — see MatchScene.onMatchEnded). Place the gate first so a
        // !DOM_HUD run never reaches showPostMatch (finding #2, HD-02).
        if (!DOM_HUD) return;
        if (disposed || shownPostMatch) return; // fire-once (HD-03).
        shownPostMatch = true;
        // onStateChange runs before onMatchEnded in the same onUpdate tick, so
        // hudRoom.state is already the RESULTS doc — resolve win/loss/draw per-seat.
        const { outcome, winnerLabel } = resolveOutcome(
          hudRoom.state as SyncedLike,
          hudRoom.sessionId,
          winnerTeam,
          draw,
        );
        // RETURN TO LOBBY reuses the existing exitConvexMatch path (no new flow / no
        // hard reload, HD-03). track() tears the overlay remover down on dispose.
        track(showPostMatch(outcome, exitConvexMatch, winnerLabel));
      },
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

  // fireRejected (C1): the scene fans a rejected shot out to this hook → a brief
  // DOM toast. track() removes any still-visible toast on page cleanup.
  setShellFireRejectedHook((reason) => {
    if (disposed) return;
    track(showFireRejectedToast(reason));
  });

  // ── enter /play ─────────────────────────────────────────────────────────────
  // Pure-Convex for BOTH modes. The lobby/room stored the matchId on
  // convexMatchSession before navigating here; a hard reload of /play/:matchId
  // re-subscribes via the matchId in the URL (the scene's bindConvexMatch →
  // convexMatchSession.subscribe self-subscribes; membership is enforced server-side
  // by api.match.get). The scene owns the gameplay intents (fire → fireShot, weapon
  // select → selectItem); EXIT → leaveMatch here.
  mountConvexMatch(roomId);
  return cleanup;
}
