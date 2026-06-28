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
import { mutation, query } from "./_generated/server";
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
  MAP,
  type MatchMode,
} from "@firewallops/match-core";
import { TerrainMask, encodeMaskRLE } from "@shared/sim";

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
 * Resolve the display handle from `accounts.display_name` (Blocker 1 — the PUBLIC
 * game handle), via the same `by_auth_user_id` index `accounts.getByAuthUserId`
 * uses (no full-table scan). Mirrors `MatchRoom.onAuth` resolving the name
 * server-side. Falls back to "AGENT" when the account row has no name yet.
 */
async function resolveDisplayName(
  ctx: { db: { query: (t: "accounts") => any } },
  accountId: string,
): Promise<string> {
  const row = await ctx.db
    .query("accounts")
    .withIndex("by_auth_user_id", (q: any) => q.eq("auth_user_id", accountId))
    .unique();
  return row?.display_name ?? "AGENT";
}

/** Reject + return the verified Clerk subject (D-10). */
async function requireIdentity(ctx: {
  auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
}): Promise<string> {
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
    await requireIdentity(ctx);

    // TODO(plan 05): if (mode === "training") → seat caller + spawnDummy +
    // startTurn (start-with-1). The open-room path below is the multiplayer flow.

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
    const mask = TerrainMask.fromMap(MAP);
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
