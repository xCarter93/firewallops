/**
 * Scheduled-internals authority tests (Phase 9, Plan 05 — GATE-SCHED /
 * GATE-ALLMODES / GATE-FORFEIT / GATE-TRAINING).
 *
 * Runs the REAL scheduled internal mutations (`startTurn`/`enterAiming`/
 * `onTurnTimeout`/`afterResolve`/`endMatch`/`endMatchDraw`) in the `edge-runtime`
 * Vitest environment with `convex-test`, `vi.useFakeTimers()`, and the scheduler
 * drains (`finishInProgressScheduledFunctions` / `finishAllScheduledFunctions`).
 *
 * Locks:
 *   (a) onTurnTimeout SKIPS — D-02: applies FORFEIT_DELAY, FIRES NOTHING, advances
 *       the turn (turnSeq bumps); no `lastShot` is ever written by a timeout.
 *   (b) a STALE onTurnTimeout no-ops — once the active player fires and the shot
 *       resolves (afterResolve → startTurn bumps turnSeq), the original timeout is
 *       stale and applies no extra FORFEIT_DELAY.
 *   (c) per-mode 1v1/2v2/4v4 `checkWinTeam` WIN + a DRAW path resolve through
 *       `afterResolve` → `endMatch`/`endMatchDraw` (GATE-ALLMODES).
 *   (d) training `afterResolve` RESPAWNS the dummy rather than ending.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import {
  TURN_MS,
  TURN_START_DWELL_MS,
  FORFEIT_DELAY,
  MAP,
} from "@firewallops/match-core";
import { TerrainMask, encodeMaskRLE } from "@shared/sim";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

const SUB_A = "user_2aAaAaAaAaAaAaAaAaAaAaAaAaA";
const SUB_B = "user_2bBbBbBbBbBbBbBbBbBbBbBbBbB";

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

/** A live mobile literal for direct doc construction in t.run. */
function mob(
  mobileId: string,
  team: number,
  hp: number,
  accountId?: string,
  passive = false,
) {
  return {
    mobileId,
    accountId,
    team,
    x: 100 + team * 1000,
    y: 400,
    hp,
    angleDeg: 45,
    power: 0,
    selectedItemId: "shot-1",
    accumulatedDelay: 0,
    ssHitCharge: 0,
    facing: team === 0 ? 1 : -1,
    ready: true,
    passive,
    displayName: team === 0 ? "A" : "B",
    connected: true,
  };
}

/** Bytes for a fresh MAP terrain mask (exact-byte slice — Pitfall 5 store side). */
function freshTerrainBytes(): ArrayBuffer {
  return encodeMaskRLE(TerrainMask.fromMap(MAP)).slice().buffer;
}

/**
 * Insert a RESOLVING match doc with the given mobiles + a `lastShot.seq` of 1, so
 * a direct `afterResolve({ shotSeq: 1 })` resolves the (already-applied) HP via
 * `checkWinTeam`. Returns the matchId.
 */
async function seedResolving(
  t: Harness,
  mode: string,
  mobiles: ReturnType<typeof mob>[],
) {
  return await t.run(async (ctx) => {
    const matchId = await ctx.db.insert("matches", {
      status: "active",
      mode,
      name: "t",
      phase: "RESOLVING",
      activeMobileId: mobiles[0].mobileId,
      wind: 0,
      turnEndsAt: 0,
      turnSeq: 1,
      winnerTeam: -1,
      terrainVersion: 1,
      mobiles,
      lastShot: {
        seq: 1,
        byMobileId: mobiles[0].mobileId,
        path: [{ x: 0, y: 0, t: 0 }],
        impact: null,
        carves: [],
        damage: [],
      },
    });
    await ctx.db.insert("matchTerrain", {
      matchId,
      version: 1,
      rle: freshTerrainBytes(),
    });
    return matchId;
  });
}

/** Drive a fresh real 1v1 to AIMING (advance the TURN_START dwell only). */
async function reach1v1Aiming(t: Harness) {
  const asA = t.withIdentity({ subject: SUB_A });
  const asB = t.withIdentity({ subject: SUB_B });
  const matchId = await asA.mutation(api.match.createRoom, {
    name: "t",
    mode: "1v1",
  });
  await asA.mutation(api.match.joinMatch, { matchId });
  await asB.mutation(api.match.joinMatch, { matchId });
  await asA.mutation(api.match.toggleReady, { matchId, ready: true });
  await asB.mutation(api.match.toggleReady, { matchId, ready: true });
  vi.advanceTimersByTime(TURN_START_DWELL_MS);
  await t.finishInProgressScheduledFunctions();
  const doc = await asA.query(api.match.get, { matchId });
  expect(doc!.phase).toBe("AIMING");
  const aMobileId = doc!.mobiles.find((m) => m.team === 0)!.mobileId;
  const activeIsA = doc!.activeMobileId === aMobileId;
  return { matchId, asA, asB, active: activeIsA ? asA : asB };
}

describe("scheduler internals — staleness + D-02 timeout skip (Plan 05)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) onTurnTimeout SKIPS — FORFEIT_DELAY applied, NO shot fired, turn advances (turnSeq bumps)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, asA } = await reach1v1Aiming(t);

    const before = await asA.query(api.match.get, { matchId });
    const seqBefore = before!.turnSeq;
    expect(before!.lastShot ?? null).toBeNull();

    // Advance past TURN_MS so the pending onTurnTimeout fires; drain the resulting
    // startTurn → enterAiming (but stop before the NEXT TURN_MS to avoid a loop).
    vi.advanceTimersByTime(TURN_MS + 1);
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(TURN_START_DWELL_MS);
    await t.finishInProgressScheduledFunctions();

    const after = await asA.query(api.match.get, { matchId });
    // The turn advanced (turnSeq bumped by the skip's startTurn).
    expect(after!.turnSeq).toBeGreaterThan(seqBefore);
    // No shot was ever fired by the timeout.
    expect(after!.lastShot ?? null).toBeNull();
    // The skipped player's delay accumulator took the FORFEIT_DELAY penalty.
    const maxDelay = Math.max(...after!.mobiles.map((m) => m.accumulatedDelay));
    expect(maxDelay).toBeGreaterThanOrEqual(FORFEIT_DELAY);
  });

  it("(b) a STALE onTurnTimeout no-ops — the player fired + resolved first (turnSeq already bumped)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, active, asA } = await reach1v1Aiming(t);

    // The turnSeq the ORIGINAL onTurnTimeout was scheduled with (the active
    // player's current turn). Once the player fires + resolves, it is stale.
    const initial = await asA.query(api.match.get, { matchId });
    const staleSeq = initial!.turnSeq;

    // Active fires BEFORE the timeout → RESOLVING + afterResolve scheduled.
    await active.mutation(api.match.fireShot, {
      matchId,
      angleDeg: 45,
      power: 80,
      itemId: "shot-1",
    });
    // Let the resolve dwell run → afterResolve → startTurn (bumps turnSeq) →
    // enterAiming (a NEW turn, NEW turnSeq, with its own fresh onTurnTimeout).
    vi.advanceTimersByTime(5_000);
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(TURN_START_DWELL_MS);
    await t.finishInProgressScheduledFunctions();

    const mid = await asA.query(api.match.get, { matchId });
    const seqAfterResolve = mid!.turnSeq;
    const delayAfterResolve = Math.max(
      ...mid!.mobiles.map((m) => m.accumulatedDelay),
    );
    // Sanity: the resolve really did advance the turn past the stale seq.
    expect(seqAfterResolve).toBeGreaterThan(staleSeq);

    // Fire the ORIGINAL (now-stale) timeout directly with its captured turnSeq,
    // in ISOLATION — advancing a full TURN_MS here would also trip the NEW turn's
    // legitimate timer and confound the assertion. The staleness guard
    // (match.turnSeq !== turnSeq) must make this a no-op.
    await t.mutation(internal.match_internal.onTurnTimeout, {
      matchId,
      turnSeq: staleSeq,
    });

    const after = await asA.query(api.match.get, { matchId });
    // The stale timeout applied NO extra FORFEIT_DELAY beyond the resolved state.
    const delayAfter = Math.max(...after!.mobiles.map((m) => m.accumulatedDelay));
    expect(delayAfter).toBe(delayAfterResolve);
    // And it did not bump turnSeq itself (it was a no-op).
    expect(after!.turnSeq).toBe(seqAfterResolve);
  });

  it.each([
    ["1v1", [["a0", 0, 100], ["b0", 1, 0]] as const],
    [
      "2v2",
      [
        ["a0", 0, 100],
        ["a1", 0, 80],
        ["b0", 1, 0],
        ["b1", 1, 0],
      ] as const,
    ],
    [
      "4v4",
      [
        ["a0", 0, 100],
        ["a1", 0, 80],
        ["a2", 0, 60],
        ["a3", 0, 40],
        ["b0", 1, 0],
        ["b1", 1, 0],
        ["b2", 1, 0],
        ["b3", 1, 0],
      ] as const,
    ],
  ])(
    "(c) %s WIN — afterResolve → endMatch when one team is wiped (GATE-ALLMODES)",
    async (mode, layout) => {
      vi.useFakeTimers();
      const t = harness();
      const mobiles = layout.map(([id, team, hp], i) =>
        mob(id, team, hp, `acct_${mode}_${i}`),
      );
      const matchId = await seedResolving(t, mode, mobiles);

      await t.mutation(internal.match_internal.afterResolve, {
        matchId,
        shotSeq: 1,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const doc = await t.run(async (ctx) => ctx.db.get(matchId));
      expect(doc!.phase).toBe("RESULTS");
      expect(doc!.winnerTeam).toBe(0); // team 0 survives, team 1 wiped.
    },
  );

  it("(c-draw) DRAW — afterResolve → endMatchDraw when ALL teams are wiped (winnerTeam -1)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const mobiles = [
      mob("a0", 0, 0, "acct_draw_a"),
      mob("b0", 1, 0, "acct_draw_b"),
    ];
    const matchId = await seedResolving(t, "1v1", mobiles);

    await t.mutation(internal.match_internal.afterResolve, {
      matchId,
      shotSeq: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const doc = await t.run(async (ctx) => ctx.db.get(matchId));
    expect(doc!.phase).toBe("RESULTS");
    expect(doc!.winnerTeam).toBe(-1); // mutual wipe → draw sentinel.
  });

  it("(c-ongoing) afterResolve → startTurn when both teams still living (no end)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const mobiles = [
      mob("a0", 0, 100, "acct_on_a"),
      mob("b0", 1, 100, "acct_on_b"),
    ];
    const matchId = await seedResolving(t, "1v1", mobiles);

    await t.mutation(internal.match_internal.afterResolve, {
      matchId,
      shotSeq: 1,
    });
    vi.advanceTimersByTime(TURN_START_DWELL_MS);
    await t.finishInProgressScheduledFunctions();

    const doc = await t.run(async (ctx) => ctx.db.get(matchId));
    expect(doc!.phase).not.toBe("RESULTS"); // continues — a new turn began.
    expect(doc!.winnerTeam).toBe(-1); // untouched (no winner set).
  });

  it("(d) training afterResolve RESPAWNS the dummy (dead) rather than ending", async () => {
    vi.useFakeTimers();
    const t = harness();
    // Human alive, dummy dead → respawn-not-end.
    const mobiles = [
      mob("human", 0, 100, "acct_train"),
      mob("dummy", 1, 0, undefined, true),
    ];
    const matchId = await seedResolving(t, "training", mobiles);

    await t.mutation(internal.match_internal.afterResolve, {
      matchId,
      shotSeq: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const doc = await t.run(async (ctx) => ctx.db.get(matchId));
    // Never ended (training continues); a FRESH dummy is alive again.
    expect(doc!.phase).not.toBe("RESULTS");
    const dummy = doc!.mobiles.find((m) => m.mobileId === "dummy")!;
    expect(dummy.hp).toBe(100);
    expect(dummy.passive).toBe(true);
  });
});
