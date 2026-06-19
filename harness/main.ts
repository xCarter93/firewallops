/**
 * DISPOSABLE "see it work" harness (Phase 1, plan 04).
 *
 * Superseded by Phase 2's real Phaser view — this is throwaway. Its ONLY jobs:
 *   1. Prove the M0 exit criterion "fire a shot, watch a crater appear".
 *   2. Render the alternate (windCoupled) projectile behavior alongside the
 *      default so the pluggable seam is VISIBLE, not just asserted.
 *
 * TIER CORRECTNESS (the keystone): this file lives OUTSIDE packages/shared and
 * imports `@shared/sim` exactly as the future Phaser client will. The pure
 * package never imports the harness; the harness uses <canvas>/DOM legitimately
 * because it is a CONSUMER, not part of the DOM-free sim core. `tsc -p harness`
 * is the real (non-grep) build gate that proves `@shared/sim` resolves from
 * outside the package.
 */
import {
  TerrainMask,
  simulateTrajectory,
  resolveShot,
} from "@shared/sim";
import type { MapDef, Mech, ProjectileDef, ShotInput } from "@shared/sim";

const MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

const DEF: ProjectileDef = {
  id: "default-shell",
  behavior: "default",
  maxDamage: 30,
  blastRadius: 60,
  grazeFloor: 5,
  directHitThreshold: 6,
  directHitBonus: 18,
  powerScale: 1,
  mass: 1,
  drag: 0,
  turnDelay: 0,
};

const SHOT: ShotInput = {
  x: 100,
  y: 300,
  angleDeg: 30,
  power: 70,
  wind: 60,
  gravity: 300,
  projectile: DEF,
};

const SOLID = "#3a5f3a";
const AIR = "#0d1b2a";
const PATH_DEFAULT = "#f4d35e";
const PATH_ALT = "#ee6c4d";

/** Paint the 1-bit collision mask: solid pixels one color, air another. */
function drawMask(ctx: CanvasRenderingContext2D, mask: TerrainMask): void {
  const img = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.bits.length; i++) {
    const solid = mask.bits[i] === 1;
    const o = i * 4;
    // SOLID / AIR are 7-char hex; pull r,g,b out.
    const hex = solid ? SOLID : AIR;
    img.data[o] = parseInt(hex.slice(1, 3), 16);
    img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
    img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Stroke a trajectory polyline. */
function drawPath(
  ctx: CanvasRenderingContext2D,
  input: ShotInput,
  terrain: TerrainMask,
  color: string,
): void {
  const { path } = simulateTrajectory(input, terrain);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(input.x, input.y);
  for (const p of path) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.font = "14px monospace";
  ctx.fillText(text, x, y);
}

function main(): void {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  canvas.width = MAP.width;
  canvas.height = MAP.height;

  // --- BEFORE: terrain + both trajectories -------------------------------
  const terrain = TerrainMask.fromMap(MAP);
  drawMask(ctx, terrain);

  // Default behavior path.
  drawPath(ctx, SHOT, terrain, PATH_DEFAULT);

  // Alternate (windCoupled) behavior, SAME inputs — measurably different path,
  // proving the pluggable seam is real (not hardcoded to the default).
  const altShot: ShotInput = {
    ...SHOT,
    projectile: { ...DEF, behavior: "windCoupled" },
  };
  drawPath(ctx, altShot, terrain, PATH_ALT);

  label(ctx, "default behavior", 12, 24, PATH_DEFAULT);
  label(ctx, "windCoupled behavior (seam proof)", 12, 44, PATH_ALT);
  label(ctx, "BEFORE: no crater", 12, 64, "#e0e1dd");

  // --- AFTER: resolve the shot, carve the crater, re-draw ----------------
  const mechs: Mech[] = [{ id: "p1", x: 360, y: 460, hp: 100 }];
  const { carves, damage } = resolveShot(SHOT, terrain, mechs, DEF);

  // The terrain mask was MUTATED in place by resolveShot — re-draw it so the
  // crater is visibly carved out ("watch a crater appear").
  drawMask(ctx, terrain);
  drawPath(ctx, SHOT, terrain, PATH_DEFAULT);
  drawPath(ctx, altShot, terrain, PATH_ALT);

  const carve = carves[0];
  const dmgText = damage.map((d) => `${d.mechId}:${d.amount.toFixed(0)}`).join(" ");
  label(
    ctx,
    carve
      ? `AFTER: crater @ (${carve.cx},${carve.cy}) r=${carve.r}  damage[ ${dmgText} ]`
      : "AFTER: shot left the map (no crater)",
    12,
    84,
    "#e0e1dd",
  );
}

main();
