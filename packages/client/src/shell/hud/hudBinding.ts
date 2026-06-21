/**
 * hudBinding.ts — the rAF tick that drives the DOM HUD overlay from a live room.
 *
 * LISTENER-OWNERSHIP INVARIANT (HIGH-risk, 06-RESEARCH): this binding READS
 * `room.state` snapshots once per animation frame and feeds the pure reducer +
 * the overlay. It MUST NOT register `room.onStateChange` or `room.onMessage` —
 * the `MatchScene` is the SOLE owner of the room's listeners; a second
 * registration would silently clobber the scene's gameplay wiring. The tick is a
 * read-only mirror: it never writes, never sends, never subscribes.
 *
 * COUNTDOWN CONTRACT (concern 4): the countdown is re-anchored using the EXACT
 * established `MatchScene` re-anchor pattern (MatchScene.ts:463-466) — when the
 * server's `turnEndsAt` changes (a new turn; the server writes it at EXACTLY ONE
 * site, MatchRoom.ts:622, fires only at turn start), reset a local deadline to
 * `now + TURN_MS_LOCAL`. The server is the real timeout authority; this readout
 * is cosmetic and may drift ~RTT. On a mid-turn JOIN the first observed
 * `turnEndsAt` re-anchors to a full local window even though the real turn is
 * partway through — this is the ACCEPTED cosmetic limitation the Phaser HUD
 * already exhibits (no synced server-time offset this phase). Do NOT add a
 * server-time-offset correction.
 *
 * SIGNATURE CONTRACT (concern 6): the overlay is driven via the ONE normalized
 * two-arg signature `overlay.update(vm, countdownText?)` — the countdown text is
 * the caller's pre-formatted "M:SS" string (empty when not in AIMING).
 */

import {
  buildViewModel,
  formatCountdown,
  shouldShowCountdown,
  type HudViewModel,
  type SyncedLike,
} from "./hudViewModel.js";

/**
 * Local mirror of the server `TURN_MS` (server config.ts), copied — NOT imported —
 * to match `MatchScene`'s `TURN_MS_LOCAL` (MatchScene.ts:87). Used ONLY for the
 * cosmetic countdown anchor.
 */
const TURN_MS_LOCAL = 20_000;

/** The minimal structural room shape the tick reads (no listener surface). */
interface RoomLike {
  readonly state: unknown;
  readonly sessionId: string;
}

/** The overlay handle the binding drives (the normalized contract — concern 6). */
interface OverlayLike {
  update(vm: HudViewModel, countdownText?: string): void;
}

/**
 * Start an rAF loop that, each frame, reads `room.state`, builds the pure HUD
 * view-model, recomputes the countdown via the established re-anchor contract,
 * and calls `overlay.update(vm, countdownText)`. Returns a disposer that cancels
 * the loop; the caller registers it (e.g. via the play page's `track()`).
 *
 * It registers NO Colyseus listener — the `MatchScene` owns the single
 * `onStateChange`. `isDisposed` is checked FIRST every frame so a late tick
 * scheduled across a teardown never reads a stale room (06-RESEARCH Pitfall 2).
 */
export function bindHudToRoom(
  room: RoomLike,
  overlay: OverlayLike,
  isDisposed: () => boolean,
): () => void {
  let lastTurnEndsAt = -1;
  let localDeadline = 0;
  let raf = 0;

  const tick = (): void => {
    if (isDisposed()) return; // Pitfall 2: never touch a torn-down room.

    const state = room.state as SyncedLike;
    const vm = buildViewModel(state, room.sessionId);

    // Re-anchor the cosmetic countdown ONLY when the server posts a new
    // turnEndsAt (a fresh turn) — the EXACT MatchScene contract (concern 4).
    if (state.turnEndsAt !== lastTurnEndsAt) {
      lastTurnEndsAt = state.turnEndsAt;
      localDeadline = performance.now() + TURN_MS_LOCAL;
    }

    const countdownText = shouldShowCountdown(state.phase)
      ? formatCountdown(localDeadline - performance.now())
      : "";

    overlay.update(vm, countdownText);

    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return () => cancelAnimationFrame(raf);
}
