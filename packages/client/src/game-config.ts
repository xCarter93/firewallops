import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene.js";
import { MatchScene } from "./scenes/MatchScene.js";

/**
 * Phaser game config. World dims are the MapDef world size (1024x512); the
 * follow-cam (later plan) handles world>viewport. BootScene runs first (loads
 * fonts + builds the mask/terrain) then hands off to MatchScene.
 * backgroundColor matches the UI-SPEC dominant (#0F172A) so there is no white
 * flash before boot.
 */
export const GAME_CONFIG: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game-container",
  backgroundColor: "#0F172A",
  width: 1024,
  height: 512,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, MatchScene],
};
