import Phaser from "phaser";
import { TerrainMask } from "@shared/sim";
import type { DirtyXRange } from "./terrainDirty.js";

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
   *
   * `region` (a [x0, x1) column band, from `carveDirtyXRange`) repaints ONLY the
   * affected columns — a carve at (cx, cy, r) can only change the top-solid of
   * columns within cx±r, so a full O(width·height) repaint per shot is wasteful
   * and causes a frame hitch on impact. Omit `region` for the full repaint
   * (initial build, reconnect RLE snapshot, rematch rebuild).
   */
  repaintFromMask(mask: TerrainMask, region?: DirtyXRange): void {
    TerrainView.paint(this.scene, this.dt, mask, region);
  }

  /**
   * Paint the field + terrain body + surface highlight from the mask into the
   * DynamicTexture. Fills the field with the dominant dark color (so any
   * carved/non-solid cell shows the dark field), then paints the body where the
   * mask is solid via a cheap per-column fill (topmost solid y down to the
   * bottom; the mask is ground-is-larger-y, matching the harness column-paint).
   *
   * With `region` set, only columns [x0, x1) are touched: the opaque full-height
   * field fill over that band erases the prior paint there (src-alpha 1 replaces,
   * so no `dt.clear()` of the rest is needed), and the per-column scan is bounded
   * to the band. Without `region`, the whole texture is cleared and repainted.
   */
  private static paint(
    scene: Phaser.Scene,
    dt: Phaser.Textures.DynamicTexture,
    mask: TerrainMask,
    region?: DirtyXRange,
  ): void {
    const { width, height } = mask;
    const x0 = region ? Math.max(0, Math.min(width, region.x0)) : 0;
    const x1 = region ? Math.max(0, Math.min(width, region.x1)) : width;
    if (x1 <= x0) return; // empty band — nothing to repaint.

    const g = scene.add.graphics();

    // Opaque field over the (band of the) texture — full-coverage src-alpha 1
    // replaces, so this also erases the prior paint in the band on a repaint.
    g.fillStyle(TerrainView.FIELD, 1);
    g.fillRect(x0, 0, x1 - x0, height);

    // Body fill where the mask is solid, scanning only the band's columns.
    g.fillStyle(TerrainView.BODY, 1);
    const tops: number[] = [];
    for (let x = x0; x < x1; x++) {
      let topSolid = -1;
      for (let y = 0; y < height; y++) {
        if (mask.isSolid(x, y)) {
          topSolid = y;
          break;
        }
      }
      tops.push(topSolid);
      if (topSolid >= 0) {
        g.fillRect(x, topSolid, 1, height - topSolid);
      }
    }

    // 2px brighter surface line along the terrain top edge (band only).
    g.fillStyle(TerrainView.SURFACE_HL, 1);
    for (let i = 0; i < tops.length; i++) {
      const top = tops[i];
      if (top >= 0) {
        g.fillRect(x0 + i, top, 1, 2);
      }
    }

    // Full repaint clears the whole texture first; a region repaint relies on the
    // opaque band fill above to replace its pixels (drawing the band-only
    // graphics leaves the rest of the texture untouched).
    if (!region) dt.clear();
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
