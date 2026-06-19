import Phaser from "phaser";
import { TerrainMask } from "@shared/sim";
import type { Carve } from "@shared/sim";

/**
 * Cosmetic terrain layer (Phase 2, plan 03).
 *
 * A Phaser 4 `DynamicTexture` that MIRRORS the `@shared/sim` collision mask.
 * The mask is the collision authority (consulted for physics); this texture is
 * purely what the player sees. It is built once from the mask and then carved
 * in lockstep with the mask via `applyCarves` (called in plan 04 when shots
 * land), so the visible craters always match the authoritative holes.
 *
 * Phaser 4 note (RESEARCH Pitfall 3): every batch of draws/erases into a
 * DynamicTexture MUST be flushed with an explicit `dt.render()` or nothing
 * shows. We flush once after building and once after each carve batch.
 *
 * This file lives under view/** so it MUST NOT import the sim's outcome
 * functions (resolveShot/simulateTrajectory/quantizeCarve) — ESLint guard.
 * Importing TerrainMask (the mask type) and Carve (a data type) is allowed.
 */
export class TerrainView {
  private static readonly FIELD = 0x0f172a; // UI-SPEC dominant (sky/backdrop)
  private static readonly BODY = 0x1e293b; // UI-SPEC secondary (terrain body)
  private static readonly ERASE_KEY = "carve-circle";

  private static readonly TEXTURE_KEY = "terrain";

  private constructor(
    private readonly scene: Phaser.Scene,
    private readonly dt: Phaser.Textures.DynamicTexture,
    private readonly image: Phaser.GameObjects.Image,
  ) {}

  /** The live DynamicTexture handle (passed to MatchScene via scene data). */
  get texture(): Phaser.Textures.DynamicTexture {
    return this.dt;
  }

  /**
   * Build the cosmetic terrain texture from the collision mask.
   *
   * Fills the whole field with the dominant dark color, then paints the
   * terrain body where the mask is solid using a cheap per-column fill: for
   * each x find the topmost solid y and draw one filled rect from that y to
   * the bottom (matches the harness column-paint; the mask is ground-is-larger-y).
   */
  static build(scene: Phaser.Scene, mask: TerrainMask): TerrainView {
    const { width, height } = mask;

    // A rematch rebuilds the terrain from a fresh mask; drop any stale texture
    // under the same key first so addDynamicTexture does not collide.
    if (scene.textures.exists(TerrainView.TEXTURE_KEY)) {
      scene.textures.remove(TerrainView.TEXTURE_KEY);
    }

    const dt = scene.textures.addDynamicTexture(TerrainView.TEXTURE_KEY, width, height);
    if (!dt) {
      throw new Error("TerrainView.build: addDynamicTexture returned null");
    }

    // Build the paint with a single Graphics object, then stamp it into the dt.
    const g = scene.add.graphics();
    g.fillStyle(TerrainView.FIELD, 1);
    g.fillRect(0, 0, width, height);

    g.fillStyle(TerrainView.BODY, 1);
    for (let x = 0; x < width; x++) {
      let topSolid = -1;
      for (let y = 0; y < height; y++) {
        if (mask.isSolid(x, y)) {
          topSolid = y;
          break;
        }
      }
      if (topSolid >= 0) {
        g.fillRect(x, topSolid, 1, height - topSolid);
      }
    }

    dt.draw(g, 0, 0);
    dt.render(); // Phaser 4 explicit flush (Pitfall 3).
    g.destroy();

    // Reusable 1px-radius white circle for erasing craters; scaled to the
    // carve radius at erase time (a white source erases via dt.erase).
    if (!scene.textures.exists(TerrainView.ERASE_KEY)) {
      const cg = scene.add.graphics();
      cg.fillStyle(0xffffff, 1);
      cg.fillCircle(1, 1, 1);
      cg.generateTexture(TerrainView.ERASE_KEY, 2, 2);
      cg.destroy();
    }

    // Add the texture to the scene at the world origin.
    const image = scene.add.image(0, 0, TerrainView.TEXTURE_KEY).setOrigin(0, 0);

    return new TerrainView(scene, dt, image);
  }

  /**
   * Erase craters out of the cosmetic layer to mirror the mask carves (PLAY,
   * called in plan 04 after a shot resolves). Each Carve is integer center +
   * radius; we scale the 2px erase sprite so its radius matches `c.r`, erase at
   * the carve center, then flush once after the whole batch (Pitfall 3).
   */
  applyCarves(carves: Carve[]): void {
    if (carves.length === 0) return;

    const eraser = this.scene.add.image(0, 0, TerrainView.ERASE_KEY);
    eraser.setOrigin(0.5, 0.5);
    eraser.setVisible(false);

    for (const c of carves) {
      // The erase source is 2px wide (1px radius); scale to a 2*r diameter.
      eraser.setScale(c.r);
      eraser.setPosition(c.cx, c.cy);
      this.dt.erase(eraser, c.cx, c.cy);
    }

    this.dt.render(); // single flush after the batch.
    eraser.destroy();
  }

  /**
   * Tear down the world image (the rematch rebuilds a fresh terrain). The
   * DynamicTexture itself is removed by the next `build` (which drops any stale
   * texture under the shared key), so we only destroy the scene image here.
   */
  destroy(): void {
    this.image.destroy();
  }
}
