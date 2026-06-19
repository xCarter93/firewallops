import Phaser from "phaser";
import { GAME_CONFIG } from "./game-config.js";

// Phaser.Game bootstrap. Scenes (BootScene/MatchScene) land in plans 03/04;
// for now this boots an empty game with the locked world dimensions so the
// workspace is provably installable and buildable (research A2 de-risk).
new Phaser.Game(GAME_CONFIG);
