/**
 * Phase 3: the loadout scalars + expandFork + muzzle offset moved to @shared/sim
 * so the server authority and this client preview import ONE source (Agreed
 * Concern #1 — no verbatim server copy). This file is now a compatibility
 * re-export; the values live in packages/shared/src/loadout.ts.
 *
 * Every existing client import site is unchanged: MatchController imports
 * `expandFork, TROJAN` from `./loadout.js`; the scene imports `LOADOUT`. They
 * all resolve through these re-exports.
 */
export {
  SHOT_1,
  SHOT_2,
  TROJAN,
  LOADOUT,
  expandFork,
  BARREL_LEN,
  muzzleOffset,
} from "@shared/sim";
export type { ShotId } from "@shared/sim";
