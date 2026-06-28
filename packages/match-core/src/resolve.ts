/**
 * Server-side shot resolution (Phase 3, Plan 03) — NET-01.
 *
 * `runServerShot` is the server's mirror of the client
 * `MatchController.applyShot` OUTCOME logic, operating on plain data (NOT the
 * Colyseus schema) so it stays unit-testable headlessly. The Room maps its
 * `Mobile` schema entries to/from `ServerMech[]` around this call.
 *
 * AUTHORITY DISCIPLINE (Agreed Concern #1 / NET-01): the loadout
 * (expandFork + the SHOT_1/2/TROJAN defs) is imported from `@shared/sim` — the
 * SINGLE source of scalars. There is NO verbatim server copy of the loadout;
 * the catalog lives in packages/shared/src/loadout.ts and both the client
 * preview and this server authority import it. The golden parity test
 * (parity.test.ts) proves runServerShot deep-equals applyShot for identical
 * inputs, so client preview and server authority cannot drift silently.
 *
 * PURITY: this module imports NOTHING from @colyseus/core, @colyseus/schema, or
 * any Room glue (no `this.clock`). It is pure sim + data so NET-01 is provable
 * without a live WebSocket server.
 */
import { expandFork, simulateTrajectory, resolveShot } from "@shared/sim";
import type {
  Carve,
  Damage,
  ProjectileDef,
  ShotInput,
  TerrainMask,
} from "@shared/sim";
import type { ShotResult } from "./shotResult.js";

/**
 * A plain mech for resolution (the Room maps its `Mobile` schema entries to/from
 * these around the call). Matches the `@shared/sim` `Mech` shape so it can be
 * passed straight into `resolveShot`.
 */
export interface ServerMech {
  id: string;
  x: number;
  y: number;
  hp: number;
}

/**
 * Resolve a fired shot into a {@link ShotResult} AND apply HP loss to `mechs`.
 *
 * Reproduces `MatchController.applyShot`'s body EXACTLY so the broadcast matches
 * the client preview byte-for-byte:
 *   - fork the aim through the SHARED `expandFork(aim, def)`
 *   - animate the first sub-shot's `simulateTrajectory` as the visible primary
 *   - loop `resolveShot(sub, terrain, mechs, sub.projectile)` over every sub-shot,
 *     pushing carves and SUMMING damage per-mech into a Map (mirrors the sim's
 *     sumPerMech so multi-carve damage combines rather than overwrites)
 *   - build `Damage[]` from the map and apply HP loss clamped at 0
 *
 * MUTATES both `terrain` (carves) and `mechs` (hp) in place — the Room owns the
 * authoritative copies and copies the resolved hp back into the schema.
 *
 * NOTE: SS-charge tick and turnDelay accumulation are NOT done here (the
 * MatchController does them on its PlayerState); the Room owns those on the
 * `Mobile` schema after this call, because they touch synced state, not the
 * pure resolution outcome.
 */
export function runServerShot(
  aim: ShotInput,
  def: ProjectileDef,
  terrain: TerrainMask,
  mechs: ServerMech[],
): ShotResult {
  const subShots = expandFork(aim, def);

  // The visible primary arc = the first sub-shot's flight.
  const primary = simulateTrajectory(subShots[0], terrain);

  const carves: Carve[] = [];
  const damageTotals = new Map<string, number>();

  for (const sub of subShots) {
    const { carves: subCarves, damage: subDamage } = resolveShot(
      sub,
      terrain,
      mechs,
      sub.projectile,
    );
    carves.push(...subCarves);
    for (const d of subDamage) {
      damageTotals.set(d.mechId, (damageTotals.get(d.mechId) ?? 0) + d.amount);
    }
  }

  const damage: Damage[] = [...damageTotals].map(([mechId, amount]) => ({
    mechId,
    amount,
  }));

  // Apply HP loss, clamped at 0 — the authoritative absolute HP.
  for (const d of damage) {
    const mech = mechs.find((m) => m.id === d.mechId);
    if (mech) mech.hp = Math.max(0, mech.hp - d.amount);
  }

  return {
    path: primary.path,
    impact: primary.impact,
    carves,
    damage,
  };
}
