/**
 * Authoritative synced match schema (Colyseus @colyseus/schema 4.x).
 *
 * This is the WIRE FORMAT every client mirrors read-only. Decorators require
 * `experimentalDecorators: true` — set in packages/server/tsconfig.json, NOT in
 * the monorepo base config (Pitfall 3).
 *
 * NO @type() on terrain/mask/bits data — the TerrainMask lives in room memory
 * only (carve-replay over shotResult.carves[] + a one-time RLE snapshot on
 * join). Adding the mask here would balloon every patch after the first carve
 * (Pitfall 4 / NET-05).
 *
 * Source for the 4.x decorator shape: 03-RESEARCH.md "Code Examples → Minimal
 * schema" (verified against docs.colyseus.io/state/schema 2026-06-19).
 */
import { Schema, MapSchema, type } from "@colyseus/schema";

export class Mobile extends Schema {
  @type("string") sessionId = "";
  /** 0 = Team A, 1 = Team B (the 2-team model, CONTEXT decision). */
  @type("number") team = 0;
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") hp = 100;
  /**
   * Last streamed aim angle. Drives BOTH the spectator barrel render AND the
   * timeout auto-fire — the spectator-aim-sync mechanism IS this schema field,
   * not a separate throttled broadcast (resolves RESEARCH Open Question 2 in
   * favor of the schema field).
   */
  @type("number") angleDeg = 45;
  /** Last streamed charge level. NOT the lock flag — see `powerLocked`. */
  @type("number") power = 0;
  /**
   * Power-COMMIT flag (PRECISE SEMANTICS — Agreed Concern #6). `powerLocked`
   * means the player has COMMITTED/RELEASED power (the release-to-fire gesture),
   * NOT merely `power > 0`. A partially-charged hold is
   * `power > 0 && powerLocked === false`. The Plan 03 `aim` handler sets
   * `powerLocked = true` ONLY on an explicit power-commit/release (an `aim`
   * message flagged as committed, or the `fire` intent's pre-commit) — never on
   * every throttled aim tick during a Space-hold. The timeout path (NET-04)
   * auto-fires ONLY if `powerLocked === true`; otherwise it SKIPS and applies
   * FORFEIT_DELAY. Plan 03's `aim` handler must re-state this exact trigger.
   */
  @type("boolean") powerLocked = false;
  /** Current shot selection — mirrors the client loadout ids. */
  @type("string") selectedItemId = "shot-1";
  /** Delay-queue accumulator — lowest acts next (PLAY-06). */
  @type("number") accumulatedDelay = 0;
  /**
   * SS-charge / Trojan arming (Authority Decision 5). Server-authoritative this
   * phase: incremented on landed damage (capped at SS_HITS_TO_ARM), a `trojan`
   * fire is rejected while below SS_HITS_TO_ARM, and firing the Trojan resets it
   * to 0. Synced so the client SS HUD pips and all tabs agree.
   */
  @type("number") ssHitCharge = 0;
  /**
   * Facing (Authority Decision 5): 1 = facing right, -1 = facing left. The
   * active mech's facing affects the absolute-angle mapping the spectator barrel
   * render reads; synced so opponents render the correct barrel orientation.
   */
  @type("number") facing = 1;
  /**
   * Reconnection lifecycle is Phase 5; field present now per §5.1 but always
   * true this phase.
   */
  @type("boolean") connected = true;
  /**
   * Lobby READY flag (Plan 04, LOBBY-04). A seated player toggles this in the
   * WAITING phase; the room auto-starts only when full && every mobile is ready.
   * Reset to its default each match.
   */
  @type("boolean") ready = false;
  /**
   * Turn-EXCLUSION marker for a server-spawned, non-client target (the Phase 8
   * training dummy). When `true`, this mobile is NEVER selected by the delay-queue
   * turn order (`advanceTurn` skips it) so the dummy never "takes a turn" and
   * soft-locks the human behind the active-player gate. ALWAYS `false` for a human
   * seat — `passive` is set SERVER-SIDE ONLY (Plan 02 `spawnDummy`); it is never
   * read from client input, so a client cannot assert passivity for itself
   * (T-08-02). Matches the existing `@type("boolean")` decorator shape so it
   * compiles under `experimentalDecorators` (boot-sensitive — typecheck does NOT
   * catch a decorator boot crash; the boot-smoke gate does).
   */
  @type("boolean") passive = false;
  /**
   * PUBLIC display handle (Blocker 1) — the name shown to OTHER players (turn
   * list + nameplate), loaded server-side from `accounts.display_name` in
   * `onAuth`. This is the ONLY identity field that crosses the wire. The Clerk
   * `sub`/accountId is held in a PRIVATE server-side `Map<sessionId, accountId>`
   * on the room and is NEVER a `@type()` field, NEVER synced, NEVER broadcast.
   */
  @type("string") displayName = "";

  // moveBudget intentionally NOT synced — movement is client-local cosmetic this
  // phase; server authority covers fire/HP/terrain/turn only (Authority
  // Decision 5). Per-turn movement does not change the authoritative HP/terrain/
  // turn outcome, so it does not need to cross the wire.
}

export class MatchState extends Schema {
  /** WAITING | TURN_START | AIMING | RESOLVING | RESULTS — NET-03 state machine. */
  @type("string") phase = "WAITING";
  /** sessionId of the active mech. */
  @type("string") activePlayer = "";
  @type("number") wind = 0;
  /** Server clock ms — drives the minimal synced countdown (NET-04). */
  @type("number") turnEndsAt = 0;
  /** -1 = no winner yet; set to the winning team on match end (banner). */
  @type("number") winnerTeam = -1;
  @type({ map: Mobile }) mobiles = new MapSchema<Mobile>();

  // NO @type() on terrain/mask/bits — the TerrainMask lives in room memory only
  // (carve-replay + RLE snapshot). Adding the mask here would balloon every
  // patch (Pitfall 4).
}
