/**
 * Scheduled / internal authority mutations (Phase 9, Plan 05).
 *
 * The in-Convex replacement for the Colyseus `MatchRoom` turn-machine internals:
 * `startTurn` (794-828), `enterAiming` (830-843), `onTimeout` (1092-1121),
 * `afterResolve` (989-1010), `endMatch`/`endMatchDraw` (1157-1179). Each is an
 * `internalMutation` (never client-callable) scheduled via `ctx.scheduler` rather
 * than `this.clock.setTimeout`.
 *
 * STALENESS GUARD over cancellable timers (D3/R5): the room's cancellable
 * `this.turnTimer`/`resolveTimer` handles are replaced by a monotonic
 * `turnSeq`/`shotSeq`. `startTurn` BUMPS `turnSeq` at its START; `fireShot`
 * advances `lastShot.seq`. Every scheduled internal re-reads the doc and NO-OPS on
 * a stale seq — so a player who fires before their timeout makes the pending
 * `onTurnTimeout` a no-op (its `turnSeq` is stale). Convex mutations are
 * exactly-once (atomic with the scheduling mutation), so the seq-guard is hygiene
 * on top of that guarantee, not a correctness crutch.
 *
 * D-02 (the ONE deliberate gameplay-behavior change): `onTurnTimeout` SKIPS the
 * turn — it applies `FORFEIT_DELAY` and advances, and FIRES NOTHING. The old
 * auto-fire-on-timeout branch is DROPPED here (and was already removed from the
 * pure turn machine in plan 02); this file must NEVER re-introduce it. Its
 * human-verify surfacing is plan 08.
 */
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  advanceTurn,
  checkWinTeam,
  shouldTrainingRespawn,
  toTurnMobile,
  surfaceY,
  randomDummyX,
  TURN_MS,
  TURN_START_DWELL_MS,
  FORFEIT_DELAY,
  MAP,
  type TurnMobile,
} from "@firewallops/match-core";
import {
  TerrainMask,
  encodeMaskRLE,
  clampAbsoluteAngle,
  aimWindowMid,
} from "@shared/sim";

/** Wind roll range (mirrors the client MatchState + server config). */
const WIND_MIN = -80;
const WIND_MAX = 80;

/**
 * Slice an encoded RLE mask to its EXACT bytes for the `v.bytes()` round-trip
 * (RESEARCH Pitfall 5 store side) — a view with `byteOffset !== 0` round-trips
 * garbage. Mirrors `match.ts`'s `exactBytes`.
 */
function exactBytes(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer;
}

/** Stable id of the server-owned training dummy. */
const DUMMY_ID = "dummy";

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

/** Map the live mobiles[] onto the pure turn-machine view (forwards `passive`). */
function turnView(mobiles: LiveMobile[]): TurnMobile[] {
  return mobiles.map((m) =>
    toTurnMobile({
      sessionId: m.mobileId,
      team: m.team,
      hp: m.hp,
      accumulatedDelay: m.accumulatedDelay,
      passive: m.passive,
    }),
  );
}

/**
 * Begin a turn (NET-03). Ports `MatchRoom.startTurn` (794-828) — the full impl
 * REPLACING the plan-04 stub body:
 *   - phase TURN_START + `turnEndsAt: 0` (presentation hygiene between turns)
 *   - `activeMobileId = advanceTurn(turnView)` (lowest-delay LIVING non-passive)
 *   - roll wind ONCE (the single wind owner)
 *   - reset the active mobile to the centered in-window aim + zeroed power
 *   - BUMP `turnSeq` at the START — the staleness-guard key replacing the
 *     cancellable `this.clock` handle (D3; the port of `clearPendingTimers`).
 *   - schedule `enterAiming` after `TURN_START_DWELL_MS` keyed on the new turnSeq.
 */
export const startTurn = internalMutation({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const match = await ctx.db.get(matchId);
    if (!match) return;

    const mobiles = match.mobiles as LiveMobile[];
    const activeMobileId = advanceTurn(turnView(mobiles));
    const wind = WIND_MIN + Math.random() * (WIND_MAX - WIND_MIN);
    const turnSeq = match.turnSeq + 1;

    // Reset the active mobile to a centered, in-window aim + zeroed power so a
    // turn that times out before any aim is at a sane default (no stale value).
    const nextMobiles = mobiles.map((m) => {
      if (m.mobileId !== activeMobileId) return m;
      const facing: 1 | -1 = m.facing === -1 ? -1 : 1;
      return {
        ...m,
        power: 0,
        angleDeg: clampAbsoluteAngle(aimWindowMid(), facing),
      };
    });

    await ctx.db.patch(matchId, {
      status: "active",
      phase: "TURN_START",
      turnEndsAt: 0,
      activeMobileId,
      wind,
      turnSeq,
      mobiles: nextMobiles,
      // Per-turn heartbeat for the idle-TTL cleanup: keeps an actively-played match
      // (incl. training, which has turnEndsAt:0) fresh so the cron never sweeps it.
      lastActivityAt: Date.now(),
    });

    await ctx.scheduler.runAfter(
      TURN_START_DWELL_MS,
      internal.match_internal.enterAiming,
      { matchId, turnSeq },
    );
  },
});

/**
 * TURN_START → AIMING (ports `MatchRoom.enterAiming` 830-843). Staleness-guard:
 * a `startTurn` (or a `fireShot`/`resetRange`-driven re-turn) that bumped
 * `turnSeq` AFTER this was scheduled makes this a no-op. Sets the AIMING phase +
 * the cosmetic deadline (`turnEndsAt`: real = now+TURN_MS, training = 0), and
 * schedules the auto-skip `onTurnTimeout` REAL MATCHES ONLY.
 */
export const enterAiming = internalMutation({
  args: { matchId: v.id("matches"), turnSeq: v.number() },
  handler: async (ctx, { matchId, turnSeq }) => {
    const match = await ctx.db.get(matchId);
    if (!match || match.turnSeq !== turnSeq) return; // STALE — no-op.
    // Terminal/phase guard: enterAiming only advances a still-active TURN_START
    // turn. A forfeit/leave can set RESULTS WITHOUT bumping turnSeq (endMatch), so
    // without this the pending dwell would overwrite RESULTS back to AIMING and
    // revive a finished match.
    if (match.status !== "active" || match.phase !== "TURN_START") return;

    const isTraining = match.mode === "training";
    await ctx.db.patch(matchId, {
      phase: "AIMING",
      turnEndsAt: isTraining ? 0 : Date.now() + TURN_MS,
    });

    // Training disables the auto-skip timer (the player takes their time).
    if (!isTraining) {
      await ctx.scheduler.runAfter(
        TURN_MS,
        internal.match_internal.onTurnTimeout,
        { matchId, turnSeq },
      );
    }
  },
});

/**
 * Turn-timeout (NET-04, D-02 SKIP-ONLY). Ports ONLY the skip branch of
 * `MatchRoom.onTimeout` (1099-1110) — the auto-fire-on-timeout branch is
 * DROPPED (D-02). Staleness-guard: if the active player already FIRED (which bumps
 * `lastShot.seq` and routes through `startTurn` → a fresh `turnSeq`), this stale
 * timer no-ops. Otherwise it penalizes the active mobile's delay accumulator with
 * `FORFEIT_DELAY` (FIRES NOTHING) and advances via `startTurn`.
 */
export const onTurnTimeout = internalMutation({
  args: { matchId: v.id("matches"), turnSeq: v.number() },
  handler: async (ctx, { matchId, turnSeq }) => {
    const match = await ctx.db.get(matchId);
    if (!match || match.turnSeq !== turnSeq) return; // STALE — already fired.
    // Phase guard: only an ACTIVE, still-AIMING turn may be skipped. A fire that
    // entered RESOLVING shares this turnSeq (startTurn bumps it only AFTER the
    // resolve dwell), so without this a last-moment shot would be wrongly skipped
    // mid-resolution; a forfeit/leave that set RESULTS (endMatch does not bump
    // turnSeq) must never be revived. afterResolve owns the RESOLVING→next step.
    if (match.status !== "active" || match.phase !== "AIMING") return;

    const mobiles = match.mobiles as LiveMobile[];
    const active = mobiles.find((m) => m.mobileId === match.activeMobileId);
    if (active) {
      // SKIP: yield the turn by penalizing the delay accumulator. Fires nothing.
      const next = mobiles.map((m) =>
        m.mobileId === active.mobileId
          ? { ...m, accumulatedDelay: m.accumulatedDelay + FORFEIT_DELAY }
          : m,
      );
      await ctx.db.patch(matchId, { mobiles: next });
    }
    await ctx.runMutation(internal.match_internal.startTurn, { matchId });
  },
});

/**
 * Post-RESOLVING transition (NET-03). Ports `MatchRoom.afterResolve` (989-1010).
 * Staleness-guard on `lastShot.seq`: a newer shot (or a reset) supersedes a stale
 * dwell. Training ALWAYS continues — if the dummy died (`shouldTrainingRespawn`)
 * respawn it with fresh terrain, then `startTurn`; it NEVER ends. Real → resolve
 * win / draw / next turn via `checkWinTeam`.
 */
export const afterResolve = internalMutation({
  args: { matchId: v.id("matches"), shotSeq: v.number() },
  handler: async (ctx, { matchId, shotSeq }) => {
    const match = await ctx.db.get(matchId);
    if (!match) return;
    if ((match.lastShot?.seq ?? 0) !== shotSeq) return; // STALE — superseded.
    // Phase guard: a reset / re-turn left RESOLVING (e.g. resetRange bumped turnSeq
    // and re-entered TURN_START without touching lastShot.seq). Only resolve a shot
    // that is STILL RESOLVING — otherwise this pending dwell is stale, no-op.
    if (match.phase !== "RESOLVING") return;

    const mobiles = match.mobiles as LiveMobile[];

    if (match.mode === "training") {
      const dummy = mobiles.find((m) => m.mobileId === DUMMY_ID);
      if (dummy && shouldTrainingRespawn(dummy.hp)) {
        // Respawn-not-end: rebuild terrain (clears craters on the version jump) +
        // a fresh passive dummy at a new varied x. Preserves the player's earned
        // ssHitCharge (only a manual RESET wipes it).
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
        const x = randomDummyX(mask);
        const freshDummy: LiveMobile = {
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
        const nextMobiles = mobiles
          .filter((m) => m.mobileId !== DUMMY_ID)
          .concat(freshDummy);
        await ctx.db.patch(matchId, {
          mobiles: nextMobiles,
          terrainVersion: nextTerrainVersion,
        });
      }
      await ctx.runMutation(internal.match_internal.startTurn, { matchId });
      return;
    }

    const outcome = checkWinTeam(turnView(mobiles));
    if (outcome.kind === "winner") {
      await ctx.runMutation(internal.match_internal.endMatch, {
        matchId,
        winnerTeam: outcome.team,
      });
    } else if (outcome.kind === "draw") {
      await ctx.runMutation(internal.match_internal.endMatchDraw, { matchId });
    } else {
      await ctx.runMutation(internal.match_internal.startTurn, { matchId });
    }
  },
});

/**
 * Build the per-player EXPLICIT-OUTCOME results (ports `finalResultsPayload`
 * 1122-1144). Each seated mobile with a bound accountId gets an explicit
 * win/loss/draw (NEVER a boolean) + a GRANULAR `${roomId}:final:${accountId}` id.
 * `winnerTeam === -1` is the draw sentinel.
 */
function finalResults(
  matchId: string,
  mobiles: LiveMobile[],
  winnerTeam: number,
): { accountId: string; outcome: "win" | "loss" | "draw"; resultId: string }[] {
  const players: {
    accountId: string;
    outcome: "win" | "loss" | "draw";
    resultId: string;
  }[] = [];
  for (const m of mobiles) {
    if (m.accountId == null) continue; // dummy / null-account — never recorded.
    const outcome: "win" | "loss" | "draw" =
      winnerTeam === -1 ? "draw" : m.team === winnerTeam ? "win" : "loss";
    players.push({
      accountId: m.accountId,
      outcome,
      resultId: `${matchId}:final:${m.accountId}`,
    });
  }
  return players;
}

/**
 * End a match with a winning team (ports `MatchRoom.endMatch` 1146-1158). Phase
 * RESULTS + `winnerTeam`, then per-player `accounts.recordResult` (granular id —
 * never collides with the `${roomId}:abandon:` id) + `matchDurability.recordEnd`.
 */
export const endMatch = internalMutation({
  args: { matchId: v.id("matches"), winnerTeam: v.number() },
  handler: async (ctx, { matchId, winnerTeam }) => {
    const match = await ctx.db.get(matchId);
    if (!match) return;
    const mobiles = match.mobiles as LiveMobile[];

    await ctx.db.patch(matchId, {
      status: "ended",
      phase: "RESULTS",
      winnerTeam,
      turnEndsAt: 0,
    });

    for (const p of finalResults(matchId, mobiles, winnerTeam)) {
      await ctx.runMutation(internal.accounts.recordResult, {
        authUserId: p.accountId,
        outcome: p.outcome,
        resultId: p.resultId,
      });
    }
    await ctx.runMutation(internal.matchDurability.recordEnd, {
      roomId: matchId,
      status: "ended",
      winnerTeam,
    });
  },
});

/**
 * Simultaneous-wipe draw (ports `MatchRoom.endMatchDraw` 1160-1168) —
 * `winnerTeam: -1` sentinel, every player `draw` (counts as neither W nor L).
 */
export const endMatchDraw = internalMutation({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const match = await ctx.db.get(matchId);
    if (!match) return;
    const mobiles = match.mobiles as LiveMobile[];

    await ctx.db.patch(matchId, {
      status: "ended",
      phase: "RESULTS",
      winnerTeam: -1,
      turnEndsAt: 0,
    });

    for (const p of finalResults(matchId, mobiles, -1)) {
      await ctx.runMutation(internal.accounts.recordResult, {
        authUserId: p.accountId,
        outcome: p.outcome,
        resultId: p.resultId,
      });
    }
    await ctx.runMutation(internal.matchDurability.recordEnd, {
      roomId: matchId,
      status: "ended",
      winnerTeam: -1,
    });
  },
});
