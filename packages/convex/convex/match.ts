/**
 * LIVE authoritative match surface — the lobby/membership half (Phase 9, Plan 04).
 *
 * This is the in-Convex replacement for the Colyseus `MatchRoom` lobby/membership
 * methods (`onCreate`/`onJoin`/`setReady`/`onSelectItem` + the `onAuth` membership
 * gate). The fireShot core + the training `createRoom` branch land in plan 05 on
 * this foundation.
 *
 * AUTHORITY INVARIANTS (D-08 / D-10 / R2 — enforced here):
 *   - Every mutation's FIRST act derives identity from `ctx.auth.getUserIdentity()`
 *     and rejects when it is null (D-10 — no guests).
 *   - `accountId` is ALWAYS `getUserIdentity().subject` — NEVER read from client
 *     args (D-08). The caller's `mobileId` is resolved SERVER-SIDE off the synced
 *     `mobiles[]` by matching `accountId`; a client-sent id is never trusted.
 *   - Pure predicates (`seatsFull` / `assignTeam` / `shouldAutoStart` / `canFire`)
 *     + layout (`spawnLayout`) + tuning (`teamSizeForMode`) are reused VERBATIM
 *     from `@firewallops/match-core` — no re-implementation (D-09 spirit).
 *   - `get` / `getTerrain` require auth AND membership (caller subject ∈
 *     `mobiles[].accountId`) before returning — porting Colyseus `onAuth`
 *     (`MatchRoom.ts:314`, review [J]). `get` then STRIPS `accountId` from every
 *     returned mobile (R2) and returns the caller's own `localMobileId` (review
 *     [I]) so the client learns its seat without `accountId` crossing the wire.
 */
import { mutation, query, type QueryCtx } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { v } from "convex/values";
import {
  seatsFull,
  assignTeam,
  shouldAutoStart,
  canFire,
  spawnLayout,
  teamSizeForMode,
  SS_HITS_TO_ARM,
  GRAVITY,
  resolveDwellMs,
  MAP,
  runServerShot,
  shouldResolveFire,
  shouldStartImmediately,
  applyTrainingHpWriteBack,
  resetPlayerShotStateOn,
  forfeitOutcome,
  surfaceY,
  settledY,
  randomDummyX,
  toTurnMobile,
  type ServerMech,
  type MatchMode,
} from "@firewallops/match-core";
import {
  TerrainMask,
  encodeMaskRLE,
  decodeMaskRLE,
  clampAbsoluteAngle,
  muzzleOffset,
  LOADOUT,
  type ProjectileDef,
  type ShotInput,
} from "@shared/sim";

/**
 * The default per-mobile HP (ported from `MatchRoom.onJoin` — `mobile.hp = 100`).
 */
const DEFAULT_HP = 100;

/**
 * `v.bytes()` stores an `ArrayBuffer`; `encodeMaskRLE` returns a `Uint8Array`
 * that MAY be a view into a larger buffer (`byteOffset !== 0`). Storing such a
 * view round-trips garbage (RESEARCH Pitfall 5). Slice to the EXACT bytes first.
 */
function exactBytes(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer;
}

/**
 * Coerce the stored `v.bytes()` `ArrayBuffer` back to a FRESH `Uint8Array`
 * before `decodeMaskRLE` (RESEARCH Pitfall 5 — the read side). Mirrors the
 * client's `room.ts` `toUint8Array` byteOffset coercion: a stored buffer must be
 * wrapped fresh so the decoder reads from offset 0 over the exact bytes.
 */
function toUint8Array(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf);
}

/** Per-mobile shape on the live `matches.mobiles[]` doc (schema mirror). */
type LiveMobile = {
  mobileId: string;
  accountId?: string;
  team: number;
  x: number;
  y: number;
  hp: number;
  angleDeg: number;
  power: number;
  selectedItemId: string;
  accumulatedDelay: number;
  ssHitCharge: number;
  facing: number;
  ready: boolean;
  passive: boolean;
  displayName: string;
  connected: boolean;
};

/** The stable id of the server-owned training dummy (mirrors MatchRoom). */
const DUMMY_ID = "dummy";

/**
 * Build a fresh passive 100hp team-1 training dummy mobile (ports
 * `MatchRoom.spawnDummy`). `passive: true` so `advanceTurn` NEVER selects it; no
 * `accountId`, so it can never reach the abandon / final-results write.
 */
function spawnDummy(mask: TerrainMask): LiveMobile {
  const x = randomDummyX(mask);
  return {
    mobileId: DUMMY_ID,
    team: 1,
    x,
    y: surfaceY(mask, Math.round(x)),
    hp: 100,
    angleDeg: 45,
    power: 0,
    selectedItemId: "shot-1",
    accumulatedDelay: 0,
    ssHitCharge: 0,
    facing: -1,
    ready: false,
    passive: true,
    displayName: "DUMMY",
    connected: true,
  };
}

/**
 * Resolve the display handle from `accounts.display_name` (Blocker 1 — the PUBLIC
 * game handle), via the same `by_auth_user_id` index `accounts.getByAuthUserId`
 * uses (no full-table scan). Mirrors `MatchRoom.onAuth` resolving the name
 * server-side. Falls back to "AGENT" when the account row has no name yet.
 */
async function resolveDisplayName(
  ctx: QueryCtx,
  accountId: string,
): Promise<string> {
  const row = await ctx.db
    .query("accounts")
    .withIndex("by_auth_user_id", (q) => q.eq("auth_user_id", accountId))
    .unique();
  return row?.display_name ?? "AGENT";
}

/** Reject + return the verified Clerk subject (D-10). */
async function requireIdentity(ctx: QueryCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");
  return identity.subject;
}

/**
 * Create an OPEN (non-training) room (LOBBY-01/03). Ports `MatchRoom.onCreate`
 * (the open-room path) + the one-shot terrain snapshot.
 *
 * Auth-required. Inserts a `matches` doc in the `open`/`WAITING` lobby state with
 * an EMPTY `mobiles` roster (the creator joins via `joinMatch` like everyone
 * else — onCreate did not seat) and a `matchTerrain` row holding the RLE mask.
 *
 * TODO(plan 05 — training branch): when `mode === "training"`, this must instead
 * seat the caller immediately, `spawnDummy()` (passive team-1 mobile), and call
 * `internal.match_internal.startTurn` (start-with-1, bypassing the ready
 * handshake — `shouldStartImmediately`). The seam is intentionally left here so
 * plan 05 fills only the training fork without re-touching the open path.
 */
export const createRoom = mutation({
  args: {
    name: v.string(),
    mode: v.string(),
  },
  handler: async (ctx, { name, mode }) => {
    const accountId = await requireIdentity(ctx);

    // Reject unknown modes BEFORE persisting — `mode` is a client arg cast to
    // MatchMode downstream (teamSizeForMode), so an unsupported value would corrupt
    // the seat math. Allow-list mirrors the MatchMode union (match-core/config).
    if (
      mode !== "1v1" &&
      mode !== "2v2" &&
      mode !== "4v4" &&
      mode !== "training"
    ) {
      throw new Error("invalid mode");
    }

    const mask = TerrainMask.fromMap(MAP);

    // TRAINING branch (plan 05 — fills the plan-04 seam, ports `MatchRoom`
    // onCreate+onJoin training fork). A training room is a 1-occupant LIVE match:
    // seat the caller, spawn the passive dummy, and start the turn IMMEDIATELY
    // (start-with-1 — bypasses the ready handshake, `shouldStartImmediately`).
    if (mode === "training") {
      // start-with-1 gate (the SAME predicate the server training branch reads).
      if (!shouldStartImmediately(true, 1)) {
        throw new Error("training must start-with-1");
      }
      const displayName = await resolveDisplayName(ctx, accountId);
      // Team-0 (left) single human seat from the spawn layout.
      const seat = spawnLayout(mask, teamSizeForMode("training"))[0];
      const human: LiveMobile = {
        mobileId: crypto.randomUUID(),
        accountId, // PRIVATE — server-set; stripped on read (R2).
        team: 0,
        x: seat.x,
        y: seat.y,
        hp: DEFAULT_HP,
        angleDeg: 45,
        power: 0,
        selectedItemId: "shot-1",
        accumulatedDelay: 0,
        ssHitCharge: 0,
        facing: 1,
        ready: false,
        passive: false,
        displayName,
        connected: true,
      };

      // Seat the dummy SYNCHRONOUSLY BEFORE startTurn so advanceTurn sees BOTH
      // mobiles (dummy passive) and returns the human (Pitfall 1 ordering).
      const matchId = await ctx.db.insert("matches", {
        status: "active",
        mode,
        name,
        phase: "TURN_START",
        activeMobileId: "",
        wind: 0,
        turnEndsAt: 0,
        turnSeq: 0,
        winnerTeam: -1,
        terrainVersion: 0,
        mobiles: [human, spawnDummy(mask)],
      });
      await ctx.db.insert("matchTerrain", {
        matchId,
        version: 0,
        rle: exactBytes(encodeMaskRLE(mask)),
      });

      // Start the turn via the REAL internal mutation (plan 05 full impl).
      await ctx.runMutation(internal.match_internal.startTurn, { matchId });
      return matchId;
    }

    const matchId = await ctx.db.insert("matches", {
      status: "open",
      mode,
      name,
      phase: "WAITING",
      activeMobileId: "",
      wind: 0,
      turnEndsAt: 0,
      turnSeq: 0,
      winnerTeam: -1,
      terrainVersion: 0,
      mobiles: [],
    });

    // One-shot RLE terrain snapshot, kept OFF the reactive `matches` doc
    // (D-11/D1). Slice to exact bytes for the `v.bytes()` round-trip (Pitfall 5).
    await ctx.db.insert("matchTerrain", {
      matchId,
      version: 0,
      rle: exactBytes(encodeMaskRLE(mask)),
    });

    return matchId;
  },
});

/**
 * Join an open room (NET-05 + LOBBY-03). Ports `MatchRoom.onJoin` (337-400): the
 * `seatsFull` overflow reject, `assignTeam` auto-balance, the `spawnLayout` seat,
 * the server-resolved `displayName`, and lock-on-full.
 *
 * `accountId` is set from the verified subject (NEVER args, D-08); `mobileId` is a
 * fresh `crypto.randomUUID()` (the stable per-match id replacing the Colyseus
 * `sessionId`).
 */
export const joinMatch = mutation({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) throw new Error("match not found");

    const teamSize = teamSizeForMode(match.mode as MatchMode);

    // Idempotency: a caller already seated does not double-join.
    if (match.mobiles.some((m) => m.accountId === accountId)) {
      return matchId;
    }

    // Joinability guard: only a WAITING lobby room accepts NEW seats. Without this
    // a stranger could join an in-progress match whose roster dipped below full
    // after a mid-match leave (seatsFull would read false) — corrupting live play.
    // The idempotent already-seated return above still lets a member re-subscribe.
    if (match.phase !== "WAITING") {
      throw new Error("match not joinable");
    }

    // Overflow guard FIRST (Authority Decision 3) — a late join into a full room
    // is rejected before any seat is created.
    if (seatsFull(match.mobiles.length, teamSize)) {
      throw new Error("match full");
    }

    const joinOrder = match.mobiles.length;
    const team = assignTeam(joinOrder, teamSize);

    // Seat from the server spawn layout (mask surface Y). The layout fills in
    // JOIN order A,B,A,B… so seats[joinOrder] aligns with assignTeam(joinOrder).
    const mask = TerrainMask.fromMap(MAP);
    const seat = spawnLayout(mask, teamSize)[joinOrder];

    const displayName = await resolveDisplayName(ctx, accountId);

    const mobile = {
      mobileId: crypto.randomUUID(),
      accountId, // PRIVATE — server-set from identity, stripped on read (R2).
      team,
      x: seat.x,
      y: seat.y,
      hp: DEFAULT_HP,
      angleDeg: 45,
      power: 0,
      selectedItemId: "shot-1",
      accumulatedDelay: 0,
      ssHitCharge: 0,
      facing: team === 0 ? 1 : -1, // A faces right, B faces left.
      ready: false,
      passive: false,
      displayName,
      connected: true,
    };

    const mobiles = [...match.mobiles, mobile];
    // LOCK ON FULL (LOBBY-03): a full room is removed from matchmaking the moment
    // every seat is filled — even before it is all-ready (START is gated on
    // full && all-ready in toggleReady).
    const status = seatsFull(mobiles.length, teamSize) ? "full" : match.status;

    await ctx.db.patch(matchId, { mobiles, status });
    return matchId;
  },
});

/**
 * Lobby ready toggle (LOBBY-04). Ports `MatchRoom.setReady` (430-446) +
 * `persistMatchStart`: acts ONLY in WAITING, flips the caller's synced `ready`,
 * then AUTO-STARTS when the room is full && every mobile is ready via the REAL
 * `internal.match_internal.startTurn` stub ([C]) — there is NO manual Start.
 *
 * Auth + membership: the caller's `mobileId` is resolved server-side off
 * `mobiles[]` by matching the verified subject (never a client-sent id).
 */
export const toggleReady = mutation({
  args: { matchId: v.id("matches"), ready: v.boolean() },
  handler: async (ctx, { matchId, ready }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) throw new Error("match not found");
    if (match.phase !== "WAITING") return;

    // Resolve the caller's mobile SERVER-SIDE (membership) — never trust a client id.
    const idx = match.mobiles.findIndex((m) => m.accountId === accountId);
    if (idx === -1) throw new Error("not a member");

    const mobiles = match.mobiles.map((m, i) =>
      i === idx ? { ...m, ready } : m,
    );
    await ctx.db.patch(matchId, { mobiles });

    const teamSize = teamSizeForMode(match.mode as MatchMode);
    const flags = mobiles.map((m) => m.ready);
    if (shouldAutoStart(mobiles.length, teamSize, flags)) {
      // REAL symbol ([C]) — plan 05 replaces the stub body. The phase leaves
      // WAITING, which the auto-start test observes.
      await ctx.runMutation(internal.match_internal.startTurn, { matchId });

      // Scoped durability (Phase 08): record the match roster the moment a REAL
      // match starts (full + all-ready), so a mid-match crash still leaves a
      // durable, attributable record. Dummy/null-account mobiles are excluded.
      const players = mobiles
        .filter((m) => m.accountId != null && !m.passive)
        .map((m) => ({
          accountId: m.accountId as string,
          team: m.team,
          displayName: m.displayName,
        }));
      await ctx.runMutation(api.matchDurability.recordStart, {
        roomId: matchId,
        mode: match.mode,
        players,
      });
    }
  },
});

/**
 * Select the active item (NET-07 arming). Ports `MatchRoom.onSelectItem`
 * (748-763): the `canFire` active-player + phase gate AND the Trojan-arm gate
 * (a `trojan` selection is rejected while `ssHitCharge < SS_HITS_TO_ARM`), both
 * reused VERBATIM from match-core / shared.
 */
export const selectItem = mutation({
  args: { matchId: v.id("matches"), itemId: v.string() },
  handler: async (ctx, { matchId, itemId }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) throw new Error("match not found");

    const idx = match.mobiles.findIndex((m) => m.accountId === accountId);
    if (idx === -1) throw new Error("not a member");
    const mobile = match.mobiles[idx];

    // Active-player + phase gate (reused verbatim).
    if (!canFire(match.phase, mobile.mobileId, match.activeMobileId)) return;

    // Trojan-arm gate: selecting the Trojan before it is earned is rejected.
    if (itemId === "trojan" && mobile.ssHitCharge < SS_HITS_TO_ARM) return;

    const mobiles = match.mobiles.map((m, i) =>
      i === idx ? { ...m, selectedItemId: itemId } : m,
    );
    await ctx.db.patch(matchId, { mobiles });
  },
});

/**
 * Resolve a fired shot — THE CORE AUTHORITY (NET-01). Ports `MatchRoom.onFire`
 * (652-689) + `resolveActiveShot` (871-980) ALMOST line-for-line, with the three
 * Convex deltas (terrain decode/re-encode, lastShot patch, scheduler.runAfter).
 *
 * EVERY outcome is re-derived from `@shared/sim` `runServerShot` INSIDE this
 * mutation — the client NEVER decides an outcome. The caller's `mobileId` is
 * resolved SERVER-SIDE off `mobiles[]` by the verified subject (D-08); a
 * client-sent id is never trusted. An out-of-turn / wrong-phase / unarmed fire is
 * a NO-OP (`shouldResolveFire` false), never a throw.
 *
 * [M] lastShot.path storage decision (Q4 / planner's discretion): the FULL
 * `lastShot.path` is stored on the live `matches` doc for v0. It is bounded by the
 * sim's `maxSteps = 2000` (ballistics.ts), so ~tens of KB/shot.
 *   MONITORING TRIGGER → switch to the client-re-simulate fallback (keep only
 *   `impact`/`carves`/`damage` authoritative on the doc and redraw the arc
 *   client-side from `{origin, angle, power, wind}`) IF a `matches` doc write ever
 *   exceeds ~100 KB OR Convex bandwidth/subscription cost on the doc surfaces in
 *   billing for typical 2v2/4v4 play. Documented defer, NOT a silent omission.
 *
 * [Q] OCC contention (document): concurrent writers to the same `matches` doc
 * (e.g. a late `toggleReady` racing this `fireShot`) can trigger a Convex OCC
 * retry. This is ACCEPTABLE for v0 — turn-based play serializes naturally and the
 * retry is transparent. No extra control is added; this is the documented
 * expectation.
 */
export const fireShot = mutation({
  args: {
    matchId: v.id("matches"),
    angleDeg: v.number(),
    power: v.number(),
    itemId: v.string(),
  },
  handler: async (ctx, { matchId, angleDeg, power, itemId }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) throw new Error("match not found");

    // Resolve the caller's mobile SERVER-SIDE off mobiles[] (never trust a
    // client-sent id — D-08). A non-member or a passive seat cannot fire.
    const idx = match.mobiles.findIndex((m) => m.accountId === accountId);
    if (idx === -1) return; // not a member — no-op.
    const active = match.mobiles[idx];

    const isTraining = match.mode === "training";

    // SINGLE fire-acceptance gate (NET-02 + Trojan-arm). Out-of-turn / wrong-phase
    // / unarmed Trojan → no-op (the SAME predicate the server `onFire` reads).
    const ok = shouldResolveFire({
      phase: match.phase,
      senderId: active.mobileId,
      activePlayer: match.activeMobileId,
      itemId,
      ssHitCharge: active.ssHitCharge,
      ssHitsToArm: SS_HITS_TO_ARM,
    });
    if (!ok) return;

    // AIM-01 authoritative clamp at the single shot-resolution seam — re-derive
    // the angle from the FIRING mobile's facing (server state, never client input).
    const facing: 1 | -1 = active.facing === -1 ? -1 : 1;
    const clampedAngle = clampAbsoluteAngle(angleDeg, facing);
    // Authoritative power clamp — mirror the angle clamp. The client charges power
    // in [0,100] (MatchScene); the server is the authority and never trusts the
    // wire value, rejecting out-of-range / non-finite power.
    const clampedPower = Number.isFinite(power)
      ? Math.max(0, Math.min(100, power))
      : 0;
    // Validate the requested item is a real LOADOUT entry BEFORE use — the client
    // controls this arg, and an unknown id would yield an undefined `def` and crash
    // the pure resolver. An invalid item is a silent no-op (like an out-of-turn
    // fire), never a throw.
    if (!Object.prototype.hasOwnProperty.call(LOADOUT, itemId)) return;
    const def: ProjectileDef = LOADOUT[itemId as keyof typeof LOADOUT];

    // Read the authoritative terrain mask from `matchTerrain`, decode it (wrap the
    // stored bytes to a fresh Uint8Array first — Pitfall 5 read side). runServerShot
    // MUTATES this mask in place (carves), so we re-encode the SAME object after.
    const terrainRow = await ctx.db
      .query("matchTerrain")
      .withIndex("by_match", (q) => q.eq("matchId", matchId))
      .unique();
    if (!terrainRow) throw new Error("terrain missing");
    const terrain = decodeMaskRLE(toUint8Array(terrainRow.rle));

    // Map mobiles[] → ServerMech[] for the pure resolver (mechId === mobileId).
    const mechs: ServerMech[] = match.mobiles.map((m) => ({
      id: m.mobileId,
      x: m.x,
      y: m.y,
      hp: m.hp,
    }));

    // Launch origin = the SHARED barrel tip (matches the client aim preview).
    const origin = muzzleOffset(active.x, active.y, clampedAngle);
    const aim: ShotInput = {
      x: origin.x,
      y: origin.y,
      angleDeg: clampedAngle,
      power: clampedPower,
      wind: match.wind,
      gravity: GRAVITY,
      projectile: def,
    };

    const result = runServerShot(aim, def, terrain, mechs);

    // Build the next mobiles[] from the resolved mechs + settle. We copy the array
    // and rewrite each mobile's hp/y; the active mobile also accumulates delay +
    // ticks SS-charge + records the clamped angle/power/item it actually fired.
    const mechById = new Map(mechs.map((m) => [m.id, m]));
    const ssAfter =
      def.id === "trojan"
        ? 0
        : result.damage.length > 0
          ? Math.min(SS_HITS_TO_ARM, active.ssHitCharge + 1)
          : active.ssHitCharge;

    const mobiles = match.mobiles.map((m) => {
      const mech = mechById.get(m.mobileId);
      // HP write-back honors applyTrainingHpWriteBack: in training the firing
      // player's OWN hp is NEVER written down (invincible); the dummy's IS.
      const hp =
        mech && applyTrainingHpWriteBack(isTraining, m.mobileId, active.mobileId)
          ? mech.hp
          : m.hp;
      // Settle every mobile onto the POST-CARVE surface (drop-only, no fall damage).
      const y = settledY(m.y, surfaceY(terrain, Math.round(m.x)));
      if (m.mobileId === active.mobileId) {
        return {
          ...m,
          hp,
          y,
          angleDeg: clampedAngle,
          power: clampedPower,
          selectedItemId: itemId,
          ssHitCharge: ssAfter,
          accumulatedDelay: m.accumulatedDelay + def.turnDelay,
        };
      }
      return { ...m, hp, y };
    });

    // Re-encode the carved mask back to `matchTerrain` (slice to exact bytes —
    // Pitfall 5 store side) + bump the version mirror (D-11/R7).
    const nextTerrainVersion = match.terrainVersion + 1;
    await ctx.db.patch(terrainRow._id, {
      version: nextTerrainVersion,
      rle: exactBytes(encodeMaskRLE(terrain)),
    });

    // S5b (TR-7 / T-08-10): in training, filter the firing player's OWN self-damage
    // out of the broadcast `damage` so no self-damage FX renders client-side
    // (the schema hp write-back already protected the player above) — the dummy's
    // damage stays visible.
    const fxDamage = isTraining
      ? result.damage.filter((d) => d.mechId !== active.mobileId)
      : result.damage;

    const shotSeq = (match.lastShot?.seq ?? 0) + 1;

    await ctx.db.patch(matchId, {
      phase: "RESOLVING",
      turnEndsAt: 0,
      terrainVersion: nextTerrainVersion,
      mobiles,
      lastShot: {
        seq: shotSeq,
        byMobileId: active.mobileId,
        path: result.path,
        impact: result.impact,
        carves: result.carves,
        damage: fxDamage,
      },
    });

    // Hold RESOLVING for the shot's flight + settle beat, then resolve the turn.
    // The dwell mirrors the client flight timing from the SAME path length.
    await ctx.scheduler.runAfter(
      resolveDwellMs(result.path.length),
      internal.match_internal.afterResolve,
      { matchId, shotSeq },
    );
  },
});

/**
 * Training-only RANGE RESET (S7 / TR-5). Ports `MatchRoom.onResetRange`
 * (1078-1086): INERT in a real match (early-return on non-training), else rebuild
 * the terrain wholesale (bump version), respawn the dummy, wipe the player's shot
 * state, and re-enter a clean turn via `startTurn`. There is no pending-timer
 * cancel to port — the staleness guard (turnSeq/shotSeq bump in `startTurn`)
 * no-ops any pending scheduled function (D3).
 */
export const resetRange = mutation({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) throw new Error("match not found");
    if (match.mode !== "training") return; // inert outside training (T-08-03).

    // Membership: only a seated caller can reset their own range.
    if (!match.mobiles.some((m) => m.accountId === accountId)) {
      throw new Error("not a member");
    }

    // Rebuild terrain wholesale from MAP (clears craters client-side on the
    // version jump). Re-encode + bump the version mirror.
    const mask = TerrainMask.fromMap(MAP);
    const nextTerrainVersion = match.terrainVersion + 1;
    const terrainRow = await ctx.db
      .query("matchTerrain")
      .withIndex("by_match", (q) => q.eq("matchId", matchId))
      .unique();
    if (terrainRow) {
      await ctx.db.patch(terrainRow._id, {
        version: nextTerrainVersion,
        rle: exactBytes(encodeMaskRLE(mask)),
      });
    }

    // Respawn the dummy at a NEW varied x + wipe the human's shot state (incl.
    // ssHitCharge — manual RESET only, via the SHARED resetPlayerShotStateOn).
    const mobiles = match.mobiles
      .filter((m) => m.mobileId !== DUMMY_ID)
      .map((m) => {
        if (m.passive) return m;
        const next = { ...m };
        resetPlayerShotStateOn(next);
        return next;
      });
    mobiles.push(spawnDummy(mask));

    await ctx.db.patch(matchId, { mobiles, terrainVersion: nextTerrainVersion });

    // Re-enter a clean turn (rolls wind once, picks the human, re-arms the dwell).
    await ctx.runMutation(internal.match_internal.startTurn, { matchId });
  },
});

/**
 * Consented LEAVE (RECON-04 / Blocker 2/5). Ports `MatchRoom.removeAndForfeit`
 * (563-648) MINUS all reconnection-window plumbing (D9 — Convex has no seat; a
 * returning client just re-subscribes). Strips the caller's mobile; in a LIVE
 * REAL match records `abandon_loss` (granular `${roomId}:abandon:${accountId}`)
 * and resolves the team-elim via `forfeitOutcome`, then advances or ends.
 *
 * A training leave writes NO result (T-08-05); a not-in-progress (WAITING /
 * RESULTS) leave just strips the seat. Idempotent: a caller already stripped is a
 * no-op.
 */
export const leaveMatch = mutation({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) throw new Error("match not found");

    const leaver = match.mobiles.find((m) => m.accountId === accountId);
    if (!leaver) return; // idempotency guard — already stripped / never seated.

    const isTraining = match.mode === "training";
    const wasInProgress =
      match.phase !== "RESULTS" && match.phase !== "WAITING";
    const wasActive = leaver.mobileId === match.activeMobileId;

    // Decide the team-elim outcome with the PURE helper BEFORE mutating, against
    // the turn view (mobileId is the turn-machine sessionId here).
    const view = match.mobiles.map((m) =>
      toTurnMobile({
        sessionId: m.mobileId,
        team: m.team,
        hp: m.hp,
        accumulatedDelay: m.accumulatedDelay,
        passive: m.passive,
      }),
    );
    const { outcome } = forfeitOutcome(view, leaver.mobileId);

    // Strip the caller's mobile.
    const mobiles = match.mobiles.filter((m) => m.mobileId !== leaver.mobileId);
    await ctx.db.patch(matchId, {
      mobiles,
      // Clear a stale active slot if the leaver was active (startTurn re-picks).
      ...(wasActive ? { activeMobileId: "" } : {}),
      // A WAITING room that drops below full is joinable again — reset the lobby
      // status so it does not stay locked as "full" after a pre-start leave.
      ...(match.phase === "WAITING"
        ? {
            status: seatsFull(
              mobiles.length,
              teamSizeForMode(match.mode as MatchMode),
            )
              ? ("full" as const)
              : ("open" as const),
          }
        : {}),
    });

    // Training leave records NO result and ends nothing (T-08-05).
    if (isTraining) return;

    // Record the abandon-loss for a live real match with a bound accountId.
    if (wasInProgress) {
      await ctx.runMutation(api.accounts.recordResult, {
        authUserId: accountId,
        outcome: "abandon_loss",
        resultId: `${matchId}:abandon:${accountId}`,
      });
      // Mark the durable match row "abandoned" (first-terminal-wins).
      await ctx.runMutation(api.matchDurability.recordEnd, {
        roomId: matchId,
        status: "abandoned",
        winnerTeam: outcome.kind === "winner" ? outcome.team : undefined,
      });
    }

    // Apply the team-elim / turn-advance outcome.
    if (outcome.kind === "winner") {
      await ctx.runMutation(internal.match_internal.endMatch, {
        matchId,
        winnerTeam: outcome.team,
      });
    } else if (outcome.kind === "draw") {
      await ctx.runMutation(internal.match_internal.endMatchDraw, { matchId });
    } else if (wasActive) {
      // continue + the leaver was active → advance the turn.
      await ctx.runMutation(internal.match_internal.startTurn, { matchId });
    }
  },
});

/**
 * Reactive match doc the client subscribes to (replaces `room.onStateChange`).
 *
 * [J] auth-required + membership-checked: rejects when `getUserIdentity()` is
 * null AND when the caller's subject is NOT among `mobiles[].accountId` — porting
 * Colyseus `onAuth` (`MatchRoom.ts:314`).
 *
 * [R2] strips `accountId` from EVERY returned mobile via
 * `({ accountId, ...pub }) => pub` — the sub NEVER crosses the wire.
 *
 * [I] ALSO returns the caller's own `localMobileId` (the `mobileId` whose
 * `accountId` === the caller's subject) so the client learns its seat id WITHOUT
 * `accountId` leaking — the Convex replacement for Colyseus `room.sessionId`
 * (plan 06 wires it into MatchScene input gating).
 */
export const get = query({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) return null;

    // [J] membership gate.
    const mine = match.mobiles.find((m) => m.accountId === accountId);
    if (!mine) throw new Error("not a member");

    return {
      ...match,
      // [R2] strip accountId from every mobile.
      mobiles: match.mobiles.map(({ accountId: _drop, ...pub }) => pub),
      // [I] the caller's own seat id, without accountId on the wire.
      localMobileId: mine.mobileId,
    };
  },
});

/**
 * One-shot RLE terrain snapshot for join / version-jump (D-11/R7). Returns the
 * `matchTerrain` `by_match` row as `{ version, rle }`.
 *
 * [J] same auth + membership gate as `get` — a non-member cannot pull the
 * terrain snapshot of a match they are not in.
 */
export const getTerrain = query({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const accountId = await requireIdentity(ctx);
    const match = await ctx.db.get(matchId);
    if (!match) return null;

    // [J] membership gate.
    if (!match.mobiles.some((m) => m.accountId === accountId)) {
      throw new Error("not a member");
    }

    const row = await ctx.db
      .query("matchTerrain")
      .withIndex("by_match", (q) => q.eq("matchId", matchId))
      .unique();
    if (!row) return null;
    return { version: row.version, rle: row.rle };
  },
});
