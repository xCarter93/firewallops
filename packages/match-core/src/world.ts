/**
 * Server world constants + spawn layout (Phase 3, Plan 03).
 *
 * MAP is a BYTE-IDENTICAL copy of packages/client/src/world.ts MAP. The server
 * and client both build their TerrainMask via `TerrainMask.fromMap(MAP)`; the
 * mask is a deterministic function of these values, so if ANY field here drifts
 * from the client world.ts the masks diverge and the SIM-04 carve-parity
 * guarantee (and the golden parity test) breaks. KEEP IN SYNC with the client.
 *
 * This module is pure data + Math: no Colyseus, no engine, no DOM — it stays
 * unit-testable headlessly (mirrors the resolve.ts purity discipline).
 */
import type { MapDef, TerrainMask } from "@shared/sim";

/**
 * The procedural heightmap definition — MUST match packages/client/src/world.ts
 * MAP exactly (2048 x 1408, seed 3, baseHeight 400, amplitude 40, frequency
 * 0.01). The client mirrors this comment; do not edit one without the other.
 */
export const MAP: MapDef = {
  width: 2048,
  height: 1408,
  seed: 3,
  baseHeight: 400,
  amplitude: 40,
  frequency: 0.01,
};

/**
 * Find the topmost solid Y at column `x` (scan from the top down for the first
 * solid pixel). Used to seat mobiles on the procedural ground. Returns
 * `mask.height` if the column is entirely air. Mirrors the client
 * world.ts `surfaceY` so spawn heights agree across authority and preview.
 */
export function surfaceY(mask: TerrainMask, x: number): number {
  for (let y = 0; y < mask.height; y++) {
    if (mask.isSolid(x, y)) return y;
  }
  return mask.height;
}

/**
 * Drop-only settle: a mobile resting at `currentY` over its column's post-carve
 * `ground` (the topmost solid Y from {@link surfaceY}) settles DOWN onto the
 * ground when terrain beneath it was carved away. It NEVER raises — carving only
 * removes terrain, so `ground` only ever moves down — and the `> +0.5` guard
 * avoids sub-pixel jitter. Uses the SAME raw `surfaceY` seating spawnLayout
 * uses, so spawn and settle never disagree. Pure geometry; NO fall damage
 * (PROJECT.md out-of-scope) — it purely repositions. Unit-tested headlessly.
 */
export function settledY(currentY: number, ground: number): number {
  return ground > currentY + 0.5 ? ground : currentY;
}

/**
 * Derive the spawn positions for a `teamSize`-per-team, 2-team match
 * (RESEARCH Open Question 3). The 2048-wide map is split into two halves; team
 * A's mobiles are spaced evenly across the LEFT half ([200, 900]) and team B's
 * across the RIGHT half ([1148, 1848]). Y is seated on the mask surface at each
 * X so mobiles sit on the procedural ground rather than a hardcoded height.
 *
 * Index order matches the JOIN order the Room assigns: seat `joinOrder` 0,1,2…
 * map to A,B,A,B… via `assignTeam`, and within a team they fill left-to-right.
 *
 * Returns one `{ x, y, team }` per seat (length `teamSize * 2`).
 */
export interface SpawnSeat {
  x: number;
  y: number;
  team: number;
}

/**
 * A varied integer x inside the team-1 (RIGHT) spawn band `[1148, 1848]` — the
 * SAME band `spawnLayout`'s `bandFor(1)` uses (Phase 8 training dummy spawn). The
 * dummy is team 1, so its randomized x must land in the right half; reusing the
 * `1148`/`1848` band literals keeps it in lockstep with `spawnLayout`.
 *
 * `rng` defaults to `Math.random` so production calls are random; tests inject a
 * deterministic rng (e.g. `() => 0.5`) to pin the band bounds. Pure geometry — NO
 * Colyseus, NO DOM (preserves this module's purity discipline).
 *
 * The `mask` param is currently UNUSED in the body: the x is band-uniform and the
 * CALLER (Plan 02 `spawnDummy`) settles the dummy's y via `surfaceY(mask, x)`, so
 * any x in the band is reachable. It is kept for signature symmetry with the other
 * world helpers and a future terrain-aware placement; y-settling is the caller's
 * `surfaceY` responsibility (Codex LOW). Prefixed `_mask` to avoid an
 * unused-parameter lint error.
 */
export function randomDummyX(_mask: TerrainMask, rng: () => number = Math.random): number {
  // 1148 / 1848 mirror bandFor(1) above — the team-1 (right) band.
  return Math.round(1148 + rng() * (1848 - 1148));
}

export function spawnLayout(mask: TerrainMask, teamSize: number): SpawnSeat[] {
  // Even spacing across each team's half. With teamSize === 1 we use the
  // band midpoint; with more, we distribute across the band inclusive of ends.
  const bandFor = (team: number): [number, number] =>
    team === 0 ? [200, 900] : [1148, 1848];

  const seatX = (team: number, indexInTeam: number): number => {
    const [lo, hi] = bandFor(team);
    if (teamSize <= 1) return Math.round((lo + hi) / 2);
    const step = (hi - lo) / (teamSize - 1);
    return Math.round(lo + indexInTeam * step);
  };

  const seats: SpawnSeat[] = [];
  // Fill in JOIN order A,B,A,B… so seats[i] aligns with assignTeam(i, teamSize).
  const perTeamCount = [0, 0];
  for (let join = 0; join < teamSize * 2; join++) {
    const team = join % 2;
    const indexInTeam = perTeamCount[team]++;
    const x = seatX(team, indexInTeam);
    const y = surfaceY(mask, x);
    seats.push({ x, y, team });
  }
  return seats;
}
