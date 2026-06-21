import type PhaserNamespace from "phaser";
import type { Room } from "@colyseus/sdk";
import { getToken } from "../auth.js";
import { matchSession } from "../net/matchSession.js";
import { provideMatchRoom, setShellMatchEndHook } from "../../net/room.js";
import type { NetHandlers } from "../../net/room.js";
import {
  classifyJoinError,
  RECONNECT_WINDOW_SECONDS,
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

/** The synced shape the play page reads to resolve the local team (read-only). */
interface SyncedMobile {
  sessionId: string;
  team: number;
}
interface SyncedState {
  mobiles: {
    forEach(cb: (mobile: SyncedMobile, key: string) => void): void;
  };
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
  let reconnecting: ReconnectingOverlay | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let matchOver = false;
  /** Removers for any mounted overlay so cleanup tears them all down. */
  const overlayRemovers: Array<() => void> = [];

  const track = (remover: () => void): void => {
    overlayRemovers.push(remover);
  };

  /** Tear down Phaser + the container (Pitfall 5). NOT a match leave. */
  const teardownPhaser = (): void => {
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

  const cleanup = (): void => {
    disposed = true;
    clearCountdown();
    setShellMatchEndHook(null); // detach the post-match hook so it can't fire after leave.
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
    root.appendChild(container);

    // BLOCKER 3: hand the ALREADY-JOINED room to the scene so MatchScene adopts
    // it (registers its listeners on the SAME seat) instead of opening a second
    // Colyseus Client. No re-join, no second seat across the room→play swap.
    provideMatchRoom(room);

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
   * Drive the SELF reconnection overlay off the room's leave/rejoin. The SDK
   * auto-reconnects transient drops; we show the overlay + a 30s countdown on a
   * non-consented leave and attempt a room-scoped resume. On resume we re-provide
   * + remount; on window expiry we show the terminal forfeit state.
   */
  const wireReconnection = (room: Room): void => {
    // Colyseus: onLeave(code) — 1000 is a normal/consented close; anything else is
    // an abnormal drop that the reconnection window covers.
    room.onLeave((code: number) => {
      if (disposed || matchOver) return;
      if (code === 1000) return; // a clean, intentional leave — no overlay.
      beginReconnect();
    });
  };

  /** Start the self-disconnect overlay + countdown + resume attempt. */
  const beginReconnect = (): void => {
    if (reconnecting || disposed || matchOver) return;
    let remaining = RECONNECT_WINDOW_SECONDS;
    reconnecting = showReconnecting(remaining);

    clearCountdown();
    countdownTimer = setInterval(() => {
      remaining -= 1;
      reconnecting?.setRemaining(remaining);
      if (remaining <= 0) {
        clearCountdown();
        // Window expired — the server forfeits the seat (RECON-04). Terminal state.
        reconnecting?.remove();
        reconnecting = null;
        track(showForfeited(returnToLobby));
      }
    }, 1000);

    // Attempt a room-scoped resume (the SDK may also auto-reconnect; either way a
    // success swaps the held room and re-binds the scene).
    void attemptResume();
  };

  /** Try to resume the held room (room-scoped reconnection token). */
  const attemptResume = async (): Promise<void> => {
    try {
      const resumed = await matchSession.reconnect(roomId, inertHandlers());
      if (disposed) return;
      if (resumed) {
        clearCountdown();
        reconnecting?.remove();
        reconnecting = null;
        track(showLinkRestored());
        // Re-provide + remount Phaser against the resumed seat (terrain snapshot +
        // state re-sync arrive on the fresh listeners).
        wireReconnection(resumed);
        mountPhaser(resumed);
      }
      // If null, the interval countdown above eventually shows the forfeit state.
    } catch {
      // Swallowed — the countdown drives the terminal forfeit state on expiry.
    }
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

  // ── enter /play ─────────────────────────────────────────────────────────────
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
