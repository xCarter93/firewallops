/**
 * THROWAWAY — GATE-R1 bundle probe (Phase 09, plan 01). DELETE ME at gate-green.
 *
 * This file exists ONLY to make the Convex esbuild bundler exercise the real
 * `@shared/sim` import graph (`.js`-on-`.ts` ESM specifiers under Bundler
 * moduleResolution) inside the Convex V8 isolate. It proves the migration's #1
 * risk (R1) is dead: the frozen crown-jewel sim bundles + runs in Convex.
 *
 * Per 09-RESEARCH §"R1 Resolution" recipe step 4, delete this file once
 * `npx convex dev --once` deploys green and `_simProbe:probe` returns a
 * non-trivial path. It is NOT a lasting symbol — no downstream code imports it.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import {
  simulateTrajectory,
  TerrainMask,
  SHOT_1,
  muzzleOffset,
} from "@shared/sim";
import type { MapDef, ShotInput } from "@shared/sim";

// A self-contained deterministic spike map (matches the @shared/sim MapDef
// contract: 1024x512, y-down). Inlined because this probe is throwaway and must
// not couple to any real map module.
const PROBE_MAP: MapDef = {
  width: 1024,
  height: 512,
  seed: 1,
  baseHeight: 380,
  amplitude: 40,
  frequency: 0.01,
};

export const probe = query({
  args: { power: v.optional(v.number()), angle: v.optional(v.number()) },
  handler: async (_ctx, { power, angle }) => {
    const shooterX = 200;
    const shooterY = 360;
    const angleDeg = angle ?? 58;

    // Launch from the barrel tip via the single muzzle-geometry authority.
    const origin = muzzleOffset(shooterX, shooterY, angleDeg);
    const input: ShotInput = {
      x: origin.x,
      y: origin.y,
      angleDeg,
      power: power ?? 70,
      wind: -15,
      gravity: 900,
      projectile: SHOT_1,
    };

    // Real TerrainMask arg is REQUIRED — simulateTrajectory(input, terrain).
    const terrain = TerrainMask.fromMap(PROBE_MAP);

    // The function returns `{ path, impact }` — NOT a bare array. Destructure.
    const { path, impact } = simulateTrajectory(input, terrain);

    return {
      len: path.length,
      first: path[0],
      last: path.at(-1),
      impact,
    };
  },
});
