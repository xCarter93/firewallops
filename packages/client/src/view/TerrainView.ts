import Phaser from "phaser";
import { TerrainMask } from "@shared/sim";

/**
 * Cosmetic terrain layer (Phase 2, plan 03).
 *
 * A Phaser 4 `DynamicTexture` that MIRRORS the `@shared/sim` collision mask.
 * The mask is the collision authority (consulted for physics); this texture is
 * purely what the player sees. It is built once from the mask and then
 * REPAINTED from the (already-carved) mask in lockstep after each shot lands
 * (`repaintFromMask`), so the visible craters always match the authoritative
 * holes exactly.
 *
 * Why repaint instead of `dt.erase`: erasing circles out of a DynamicTexture
 * depends on Phaser's ERASE blend-mode + the eraser object's render state,
 * which proved unreliable here (craters carved in the mask but invisible on
 * screen). Repainting the whole field from the mask is the cheap, deterministic
 * mirror — the mask is the single source of truth and is already carved by
 * `applyShot`, so the texture can never drift from collision. A full repaint is
 * O(width·height) but runs at most once per turn (negligible).
 *
 * Phaser 4 note (RESEARCH Pitfall 3): every batch of draws into a
 * DynamicTexture MUST be flushed with an explicit `dt.render()` or nothing
 * shows. We flush once after each paint.
 *
 * This file lives under view/** so it MUST NOT import the sim's outcome
 * functions (resolveShot/simulateTrajectory/quantizeCarve) — ESLint guard.
 * Importing TerrainMask (the mask type) is allowed.
 */
export class TerrainView {
  private static readonly FIELD = 0x0f172a; // UI-SPEC dominant (sky/backdrop)
  // The terrain body must read clearly against the dark `#0F172A` field, so a
  // carved crater (repainted back to the dark field) is obviously visible.
  private static readonly BODY = 0x475569; // visible terrain body (slate-600)
  private static readonly SURFACE_HL = 0x64748b; // top-edge highlight (slate-500)

  private static readonly TEXTURE_KEY = "terrain";
  /** Background depth — below mechs/projectiles/HUD (which default to depth 0+). */
  static readonly DEPTH = -100;

  private constructor(
    private readonly scene: Phaser.Scene,
    private readonly dt: Phaser.Textures.DynamicTexture,
    private readonly image: Phaser.GameObjects.Image,
  ) {}

  /** The live DynamicTexture handle. */
  get texture(): Phaser.Textures.DynamicTexture {
    return this.dt;
  }

  /**
   * Build the cosmetic terrain texture from the collision mask and add it to the
   * scene at the world origin. MUST be called from the scene that renders the
   * match (the world Image lives on that scene's display list).
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

    TerrainView.paint(scene, dt, mask);

    // Terrain is the BACKGROUND layer — pin it to a low depth so a mid-match
    // rebuild (networked RLE snapshot via MatchScene.rebuildTerrain) cannot paint
    // over the mechs / HUD that were created earlier. Without this, z-order is
    // pure creation order and the rebuilt terrain hides everything above it.
    const image = scene.add
      .image(0, 0, TerrainView.TEXTURE_KEY)
      .setOrigin(0, 0)
      .setDepth(TerrainView.DEPTH);

    return new TerrainView(scene, dt, image);
  }

  /**
   * Repaint the cosmetic layer from the current (carved) mask so visible craters
   * mirror the authoritative holes. Called after each shot resolves (PLAY-04) —
   * the mask was already carved inside `applyShot`, so this just re-mirrors it.
   */
  repaintFromMask(mask: TerrainMask): void {
    TerrainView.paint(this.scene, this.dt, mask);
  }

  /**
   * Paint the field + terrain body + surface highlight from the mask into the
   * DynamicTexture. Fills the whole field with the dominant dark color (so any
   * carved/non-solid cell shows the dark field), then paints the body where the
   * mask is solid via a cheap per-column fill (topmost solid y down to the
   * bottom; the mask is ground-is-larger-y, matching the harness column-paint).
   */
  private static paint(
    scene: Phaser.Scene,
    dt: Phaser.Textures.DynamicTexture,
    mask: TerrainMask,
  ): void {
    const { width, height } = mask;

    const g = scene.add.graphics();

    // Opaque field over the whole texture — this also erases the prior paint on
    // a repaint (full-coverage, src-alpha 1 replaces).
    g.fillStyle(TerrainView.FIELD, 1);
    g.fillRect(0, 0, width, height);

    // Body fill where the mask is solid.
    g.fillStyle(TerrainView.BODY, 1);
    const tops: number[] = new Array(width).fill(-1);
    for (let x = 0; x < width; x++) {
      let topSolid = -1;
      for (let y = 0; y < height; y++) {
        if (mask.isSolid(x, y)) {
          topSolid = y;
          break;
        }
      }
      tops[x] = topSolid;
      if (topSolid >= 0) {
        g.fillRect(x, topSolid, 1, height - topSolid);
      }
    }

    // 2px brighter surface line along the terrain top edge.
    g.fillStyle(TerrainView.SURFACE_HL, 1);
    for (let x = 0; x < width; x++) {
      if (tops[x] >= 0) {
        g.fillRect(x, tops[x], 1, 2);
      }
    }

    dt.clear();
    dt.draw(g, 0, 0);
    dt.render(); // Phaser 4 explicit flush (Pitfall 3).
    g.destroy();
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
