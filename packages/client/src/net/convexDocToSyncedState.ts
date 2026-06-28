/**
 * convexDocToSyncedState — the PURE Convex-doc → scene-state adapter (plan 09-06,
 * Task 1; CONVEX-MIGRATION §8, 09-PATTERNS §convexDocToSyncedState).
 *
 * This is the single seam that lets the entire Phaser render path
 * (`MatchScene.syncFromState`, MatchScene.ts:461) consume the Convex authority doc
 * (`api.match.get`, plan 04) WITHOUT touching what the scene does with the state —
 * only the SOURCE of state changes. The Convex doc differs from the old Colyseus
 * `MatchState` in exactly two shapes:
 *   1. `activeMobileId` (a stable per-match mobile id) instead of `activePlayer`.
 *   2. `mobiles` is a flat ARRAY, whereas the scene reads a MapSchema-like iterable
 *      exposing `forEach(cb) + size` (MatchScene.ts:131-141).
 * This mapper bridges both, producing the EXACT `SyncedState`/`SyncedMobile` shape
 * the scene already consumes (sessionId sourced from mobileId; connected defaulting
 * true). It is deliberately Phaser/scene-free so it is unit-testable headless — it
 * imports NOTHING from Phaser, the scene, or the sim outcome functions.
 *
 * Mirrors the scene-side `SyncedMobile`/`SyncedState` interfaces (MatchScene.ts:
 * 109-141) — kept structurally identical here so the mapper output is assignable to
 * what `syncFromState` reads (the scene keeps its own copy of the interface so it
 * stays decoupled from net/; this file re-declares the same shape it produces).
 */

/** One mobile on the Convex `matches` doc as returned by `api.match.get`. */
export interface ConvexMobile {
  mobileId: string;
  team: number;
  x: number;
  y: number;
  hp: number;
  angleDeg: number;
  power: number;
  facing: number;
  ssHitCharge: number;
  accumulatedDelay: number;
  selectedItemId: string;
  /** Presence flag on the wire; defaults true when absent. */
  connected?: boolean;
  /** Carried but unused by the mapper; present on the doc shape. */
  ready?: boolean;
  passive?: boolean;
  displayName?: string;
  /**
   * `accountId` is STRIPPED by `api.match.get` (R2) before it reaches the client —
   * it must never appear here. Declared optional + never read so the type tolerates
   * the doc while documenting the invariant.
   */
  accountId?: undefined;
}

/**
 * The `api.match.get` return doc the client subscribes to (plan 04 `get`):
 * the full `matches` doc with `accountId` stripped from every mobile and the
 * caller's own `localMobileId` appended. The mapper consumes only the gameplay
 * fields below; `localMobileId` is surfaced separately by convexClient ([I]).
 */
export interface ConvexMatchDoc {
  phase: string;
  activeMobileId: string;
  wind: number;
  turnEndsAt: number;
  winnerTeam: number;
  mobiles: ConvexMobile[];
  /** [I] the caller's own seat id (surfaced by convexClient, not by this mapper). */
  localMobileId?: string;
}

/** The synced Mobile shape MatchScene reads (mirror of MatchScene.ts:109-128). */
export interface SyncedMobile {
  sessionId: string;
  team: number;
  x: number;
  y: number;
  hp: number;
  angleDeg: number;
  power: number;
  facing: number;
  ssHitCharge: number;
  accumulatedDelay: number;
  selectedItemId: string;
  connected: boolean;
}

/**
 * A MapSchema-shaped iterable over the mobiles, keyed by mobileId — the minimal
 * surface `syncFromState` uses (`state.mobiles.forEach((m, key) => ...)` +
 * `state.mobiles.size`, MatchScene.ts:493/137-140).
 */
export interface SyncedMobiles {
  forEach(cb: (mobile: SyncedMobile, key: string) => void): void;
  readonly size: number;
}

/** The synced MatchState shape MatchScene reads (mirror of MatchScene.ts:130-141). */
export interface SyncedState {
  phase: string;
  activePlayer: string;
  wind: number;
  turnEndsAt: number;
  winnerTeam: number;
  mobiles: SyncedMobiles;
}

/** Map one Convex mobile to the scene's SyncedMobile (sessionId ← mobileId). */
function toSyncedMobile(m: ConvexMobile): SyncedMobile {
  return {
    sessionId: m.mobileId,
    team: m.team,
    x: m.x,
    y: m.y,
    hp: m.hp,
    angleDeg: m.angleDeg,
    power: m.power,
    facing: m.facing,
    ssHitCharge: m.ssHitCharge,
    accumulatedDelay: m.accumulatedDelay,
    selectedItemId: m.selectedItemId,
    // Presence defaults true when the field is absent (matches the scene's
    // `mobile.connected !== false` read, MatchScene.ts:534).
    connected: m.connected !== false,
  };
}

/**
 * Convert the Convex match doc to the scene's `SyncedState` (pure). `activePlayer`
 * comes from `activeMobileId`; scalars pass through; `mobiles[]` becomes a
 * `{forEach,size}` iterable keyed by mobileId. The scene reads this exactly as it
 * read the Colyseus MapSchema — no MatchScene field-consumption change.
 */
export function convexDocToSyncedState(doc: ConvexMatchDoc): SyncedState {
  const entries: [string, SyncedMobile][] = doc.mobiles.map((m) => [
    m.mobileId,
    toSyncedMobile(m),
  ]);

  const mobiles: SyncedMobiles = {
    size: entries.length,
    forEach(cb: (mobile: SyncedMobile, key: string) => void): void {
      for (const [key, mobile] of entries) cb(mobile, key);
    },
  };

  return {
    phase: doc.phase,
    activePlayer: doc.activeMobileId,
    wind: doc.wind,
    turnEndsAt: doc.turnEndsAt,
    winnerTeam: doc.winnerTeam,
    mobiles,
  };
}
