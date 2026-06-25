import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene.js";
import { MatchScene } from "./scenes/MatchScene.js";

/**
 * Phaser game config.
 *
 * `Scale.RESIZE` makes the canvas FILL the whole browser window (the
 * `#game-container` is 100vw×100vh) instead of letterboxing a fixed 1024×512
 * design frame. This fixes three things at once vs the old `Scale.FIT`:
 *  - no dead space — the canvas occupies the entire viewport, so the HUD (which
 *    pins to `cam.height - BAR_H`) sits at the TRUE window bottom;
 *  - crisper — `FIT` rendered a 1024-wide buffer and stretched it to ~window
 *    width (the dominant blur source); RESIZE sizes the backing store to the
 *    live window width, so there is no upscale;
 *  - `cam.width`/`cam.height` now equal the live viewport, so the larger world
 *    (MAP) can use the full height.
 *
 * Caveat: Phaser 4's Scale Manager does NOT multiply the backing store by
 * `window.devicePixelRatio` (confirmed against the Scale Manager docs), so this
 * is crisp at 1 canvas-px per CSS-px. True device-pixel (Retina) rendering would
 * need a camera-zoom pass and is deferred. Mid-game window-resize reflow of the
 * HUD is likewise deferred — the initial layout is correct for the boot window.
 *
 * BootScene runs first (loads fonts + builds the mask/terrain) then hands off to
 * MatchScene. backgroundColor matches the UI-SPEC dominant (#0F172A) so there is
 * no white flash before boot — and it doubles as the "sky" above the terrain.
 */
const initialWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
const initialHeight = typeof window !== "undefined" ? window.innerHeight : 512;

export const GAME_CONFIG: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game-container",
  backgroundColor: "#0F172A",
  width: initialWidth,
  height: initialHeight,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoRound: true,
  },
  // Zero-risk render hint (does NOT change world/HUD/input coordinates):
  // powerPreference asks the browser for the discrete GPU on dual-GPU laptops.
  // NOTE: true device-pixel (Retina) crispness is NOT a config flag here — with
  // Scale.RESIZE the canvas is a 1:1 CSS↔backing-store map, so a sharp Hi-DPI
  // render needs a manual backing-store + camera-zoom pass, and Phaser 4.1 has
  // an open Hi-DPI line-rendering regression (phaserjs/phaser#7198). Deferred
  // until it can be verified on a real Retina display (see plan).
  render: {
    powerPreference: "high-performance",
  },
  // `target` is a hint only (does not cap rAF); it tunes delta smoothing.
  fps: {
    target: 60,
  },
  scene: [BootScene, MatchScene],
};
