/**
 * hudPreviewData.ts — the `?hudpreview` fast-iteration fixture + renderer.
 *
 * This is the presentation-only dev route: it mounts the real `hudOverlay`
 * (06-03) fed a STATIC `PREVIEW_VM` over a fake `#game-container` — NO auth, NO
 * Colyseus, NO Phaser, NO network. It lets a designer iterate the HUD chrome at
 * `http://localhost:5173/?hudpreview=1` without standing up a live match.
 *
 * The fixture is hand-built to exercise EVERY render channel so the preview shows
 * each region populated: a local YOU row, an active row, an eliminated row, a
 * disconnected row (CF-1 / D-06 AWAY), the round em-dash sentinel, a populated
 * action bar (mid power, a selected chip, the trojan 2/3 locked state, the MOVE
 * dash), wind + minimap blips, and the AIMING countdown.
 *
 * SECURITY (T-06-07): the preview renders ONLY this static fixture — no user data,
 * no real state — so the before-auth-gate placement in the router exposes nothing.
 */

import { FONT, MESH } from "../meshed.js";
import { formatCountdown, type HudViewModel } from "./hudViewModel.js";
import { mountHudOverlay } from "./hudOverlay.js";

/**
 * A static, representative HUD view-model satisfying the plan-01 `HudViewModel`
 * type. Every region is populated (see the channels above). `round: -1` renders
 * the em-dash; one row is `connected: false` (CF-1), one is `eliminated`, one is
 * `isLocal` (the YOU badge). The action bar previews a mid power, a selected chip,
 * the trojan `2/3` locked state, and the `moveBudget: -1` dash.
 */
export const PREVIEW_VM: HudViewModel = {
  round: -1, // renders "—"
  phase: "AIMING",
  activeLabel: "YOUR TURN",
  activeIsLocal: true,
  localPlayerId: "sess-you",
  turnRows: [
    {
      id: "sess-you",
      label: "YOU",
      isLocal: true,
      hp: 88,
      isActive: true,
      eliminated: false,
      connected: true,
      team: 0,
    },
    {
      id: "sess-ally",
      label: "BYTEKNIGHT",
      isLocal: false,
      hp: 54,
      isActive: false,
      eliminated: false,
      connected: true,
      team: 0,
    },
    {
      id: "sess-enemy",
      label: "TEAM B",
      isLocal: false,
      hp: 21,
      isActive: false,
      eliminated: false,
      connected: false, // CF-1 / D-06 — previews the AWAY (disconnected) state
      team: 1,
    },
    {
      id: "sess-down",
      label: "R00TK1T",
      isLocal: false,
      hp: 0,
      isActive: false,
      eliminated: true, // previews the strike-through OUT state
      connected: true,
      team: 1,
    },
  ],
  wind: 7,
  blips: [
    { id: "sess-you", xFrac: 0.16, team: 0, isActive: true },
    { id: "sess-ally", xFrac: 0.38, team: 0, isActive: false },
    { id: "sess-enemy", xFrac: 0.74, team: 1, isActive: false },
    { id: "sess-down", xFrac: 0.91, team: 1, isActive: false },
  ],
  actionBar: {
    weapons: [
      { id: "packet", label: "PACKET", selected: false, locked: false },
      { id: "forked", label: "FORKED", selected: true, locked: false },
      {
        id: "trojan",
        label: "TROJAN",
        selected: false,
        locked: true, // ssHitCharge 2 < 3 → locked
        chargeLabel: "2/3",
      },
    ],
    power: 62,
    angleDeg: 41,
    selectedItemId: "shot-2", // matches the FORKED chip
    ssHitCharge: 2, // previews the trojan 2/3 locked state
    powerLocked: false,
    moveBudget: -1, // previews the MOVE em-dash (not synced)
    hasLocalMobile: true,
  },
  winnerTeam: -1,
  matchOver: false,
};

/** The preview countdown ticks 18 → 0 then holds, re-rendering the overlay. */
const PREVIEW_COUNTDOWN_START_MS = 18_000;
const PREVIEW_TICK_MS = 1_000;

/**
 * Render the `?hudpreview` route into `root`: clear it, build a fake positioned
 * `#game-container` with a static grid backdrop, mount the overlay, and feed it
 * `PREVIEW_VM`. Starts a 1s interval that ticks the countdown 18 → 0 (cosmetic).
 * Returns a cleanup that destroys the overlay, clears the interval, and removes
 * the container — wired into the router's `pageCleanup`. No auth/Colyseus/network.
 */
export function renderHudPreview(root: HTMLElement): () => void {
  root.innerHTML = "";

  // A fake positioned container so the overlay (`inset:0`) anchors to it (the same
  // role #game-container plays in /play). Static grid backdrop — no Phaser.
  const container = document.createElement("div");
  container.id = "game-container";
  Object.assign(container.style, {
    position: "relative",
    width: "100vw",
    height: "100vh",
    background: MESH.field,
    backgroundImage:
      "linear-gradient(rgba(95,200,245,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(95,200,245,0.05) 1px, transparent 1px)",
    backgroundSize: "40px 40px",
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);

  // A faint preview watermark so it is obvious this is the dev fixture, not a match.
  const watermark = document.createElement("div");
  watermark.textContent = "HUD PREVIEW — STATIC FIXTURE";
  Object.assign(watermark.style, {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    fontFamily: FONT.mono,
    fontSize: "12px",
    letterSpacing: "0.12em",
    color: "rgba(95,200,245,0.18)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  container.appendChild(watermark);

  root.appendChild(container);

  const overlay = mountHudOverlay(container);
  overlay.update(PREVIEW_VM, formatCountdown(PREVIEW_COUNTDOWN_START_MS));

  // Cosmetically tick the countdown 18 → 0 so the timer reads "live" in the preview.
  let remainingMs = PREVIEW_COUNTDOWN_START_MS;
  const timer = setInterval(() => {
    remainingMs -= PREVIEW_TICK_MS;
    if (remainingMs < 0) remainingMs = 0;
    overlay.update(PREVIEW_VM, formatCountdown(remainingMs));
  }, PREVIEW_TICK_MS);

  return () => {
    clearInterval(timer);
    overlay.destroy();
    container.remove();
  };
}
