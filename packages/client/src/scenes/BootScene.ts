import Phaser from "phaser";
import { TerrainMask } from "@shared/sim";
import type { MapDef } from "@shared/sim";
import { MAP } from "../world.js";
import { TerrainView } from "../view/TerrainView.js";

/**
 * Scene init payload handed from BootScene → MatchScene.
 *
 * Carries the live collision mask, the cosmetic terrain texture handle, and
 * the map def. MatchScene consumes these instead of re-deriving them, so the
 * mask is built exactly once (the same authority the previews query).
 */
export interface MatchSceneData {
  mask: TerrainMask;
  terrain: TerrainView;
  map: MapDef;
}

/**
 * Boot scene (Phase 2, plan 03).
 *
 * Job: (1) await the web fonts so the first HUD/canvas frame renders in the
 * correct family (no FOUT, RESEARCH Pitfall 5); (2) build the @shared/sim
 * collision mask (the authority); (3) build the cosmetic DynamicTexture mirror
 * via TerrainView; (4) hand off to MatchScene with the live handles.
 *
 * Lives under scenes/** — the ESLint seam guard forbids importing the sim's
 * outcome functions here; TerrainMask + MapDef (the mask build) are allowed.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  async create(): Promise<void> {
    // (1) Kill canvas FOUT: load each family at a representative size, then
    // await the document font set before any text renders (Pitfall 5).
    if (typeof document !== "undefined" && document.fonts) {
      try {
        await Promise.all([
          document.fonts.load("24px 'Share Tech Mono'"),
          document.fonts.load("14px 'Fira Code'"),
          document.fonts.load("700 48px 'Orbitron'"),
        ]);
        await document.fonts.ready;
      } catch {
        // Font loading is best-effort; a CDN hiccup must not block the game.
      }
    }

    // (2) The collision authority — byte-identical to the server (SIM-04).
    const mask = TerrainMask.fromMap(MAP);

    // (3) The cosmetic mirror (DynamicTexture). Built here so the terrain
    // texture exists before MatchScene adds its world objects on top.
    const terrain = TerrainView.build(this, mask);

    // (4) Hand off the live handles.
    const data: MatchSceneData = { mask, terrain, map: MAP };
    this.scene.start("Match", data);
  }
}
