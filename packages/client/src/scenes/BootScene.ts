import Phaser from "phaser";
import { TerrainMask } from "@shared/sim";
import type { MapDef } from "@shared/sim";
import { MAP } from "../world.js";

/**
 * Scene init payload handed from BootScene → MatchScene.
 *
 * Carries the live collision mask (the authority) and the map def. MatchScene
 * consumes these instead of re-deriving them, so the mask is built exactly once
 * (the same authority the previews query). The cosmetic terrain TEXTURE is
 * deliberately NOT built here — MatchScene builds it, so its world Image lives
 * on the Match display list (see BootScene.create note).
 */
export interface MatchSceneData {
  mask: TerrainMask;
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
    // Built once here and handed off. The cosmetic TerrainView mirror is built
    // INSIDE MatchScene (not here): a terrain Image added to BootScene's display
    // list is destroyed when this scene shuts down on scene.start, leaving the
    // global DynamicTexture with nothing rendering it — that was the 02-04
    // "invisible terrain" bug.
    const mask = TerrainMask.fromMap(MAP);

    // (3) Hand off the live mask + map.
    const data: MatchSceneData = { mask, map: MAP };
    this.scene.start("Match", data);
  }
}
