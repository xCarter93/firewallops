/**
 * Retention / cleanup-sweep tests (Phase 9) — exercises the REAL cron handlers
 * (`cleanup.sweepMatches` / `cleanup.sweepResultEvents`) in the edge-runtime Vitest
 * env with `convex-test`. Fake timers + `vi.setSystemTime` control both the doc
 * `lastActivityAt` and the system `_creationTime` so the idle / TTL thresholds are
 * deterministic.
 *
 * Locks:
 *   (a) a match idle past the 30-min window is deleted AND its `matchTerrain` +
 *       `matchAim` children are CASCADED (no orphans); a fresh match + children survive.
 *   (b) an `active` match with a FUTURE `turnEndsAt` is protected even when stale
 *       (the liveness belt-and-suspenders guard).
 *   (c) a legacy row with NO `lastActivityAt` is swept (it sorts first in the index).
 *   (d) `result_events` older than the 7-day TTL are pruned; recent ones survive.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import { TerrainMask, encodeMaskRLE } from "@shared/sim";
import { MAP } from "@firewallops/match-core";
import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

const BASE = 1_900_000_000_000; // fixed wall clock for deterministic thresholds
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function harness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof harness>;

function freshTerrainBytes(): ArrayBuffer {
  return encodeMaskRLE(TerrainMask.fromMap(MAP)).slice().buffer;
}

/** Insert a minimal-but-valid `matches` doc with the given overrides; returns its id. */
async function insertMatch(
  t: Harness,
  overrides: Partial<{
    status: "open" | "full" | "active" | "ended";
    mode: string;
    phase: string;
    turnEndsAt: number;
    lastActivityAt: number | undefined;
  }>,
) {
  return await t.run(async (ctx) => {
    const doc = {
      status: overrides.status ?? "ended",
      mode: overrides.mode ?? "1v1",
      name: "t",
      phase: overrides.phase ?? "RESULTS",
      activeMobileId: "",
      wind: 0,
      turnEndsAt: overrides.turnEndsAt ?? 0,
      turnSeq: 0,
      winnerTeam: -1,
      terrainVersion: 0,
      mobiles: [],
      ...("lastActivityAt" in overrides
        ? { lastActivityAt: overrides.lastActivityAt }
        : {}),
    };
    return await ctx.db.insert("matches", doc);
  });
}

async function addChildren(t: Harness, matchId: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("matchTerrain", {
      matchId: matchId as never,
      version: 0,
      rle: freshTerrainBytes(),
    });
    await ctx.db.insert("matchAim", {
      matchId: matchId as never,
      mobileId: "m1",
      angleDeg: 45,
      seq: 1,
    });
    await ctx.db.insert("matchAim", {
      matchId: matchId as never,
      mobileId: "m2",
      angleDeg: 90,
      seq: 1,
    });
  });
}

async function counts(t: Harness) {
  return await t.run(async (ctx) => ({
    matches: (await ctx.db.query("matches").collect()).length,
    terrain: (await ctx.db.query("matchTerrain").collect()).length,
    aim: (await ctx.db.query("matchAim").collect()).length,
    resultEvents: (await ctx.db.query("result_events").collect()).length,
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("cleanup.sweepMatches", () => {
  it("deletes idle matches and CASCADES terrain + aim; fresh ones survive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const t = harness();

    const stale = await insertMatch(t, { lastActivityAt: BASE - 31 * MIN });
    await addChildren(t, stale);
    const fresh = await insertMatch(t, { lastActivityAt: BASE - 1 * MIN });
    await addChildren(t, fresh);

    const res = await t.mutation(internal.cleanup.sweepMatches, {});
    expect(res.deletedMatches).toBe(1);
    expect(res.deletedTerrain).toBe(1);
    expect(res.deletedAim).toBe(2);

    const c = await counts(t);
    // Only the fresh match + its 1 terrain + 2 aim remain.
    expect(c.matches).toBe(1);
    expect(c.terrain).toBe(1);
    expect(c.aim).toBe(2);

    const survivor = await t.run(async (ctx) => ctx.db.get(fresh as never));
    expect(survivor).not.toBeNull();
  });

  it("protects an active match with a FUTURE turnEndsAt even when stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const t = harness();

    await insertMatch(t, {
      status: "active",
      phase: "AIMING",
      lastActivityAt: BASE - 1 * HOUR, // stale → in the candidate set
      turnEndsAt: BASE + 1 * MIN, // …but a live turn is in flight
    });

    const res = await t.mutation(internal.cleanup.sweepMatches, {});
    expect(res.deletedMatches).toBe(0);
    expect((await counts(t)).matches).toBe(1);
  });

  it("sweeps a legacy row that has no lastActivityAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const t = harness();

    await insertMatch(t, { lastActivityAt: undefined });

    const res = await t.mutation(internal.cleanup.sweepMatches, {});
    expect(res.deletedMatches).toBe(1);
    expect((await counts(t)).matches).toBe(0);
  });
});

describe("cleanup.sweepResultEvents", () => {
  it("prunes rows older than the 7-day TTL; recent ones survive", async () => {
    vi.useFakeTimers();
    const t = harness();

    // Backdate _creationTime by inserting under an earlier system clock.
    vi.setSystemTime(BASE - 8 * DAY);
    await t.run(async (ctx) => {
      await ctx.db.insert("result_events", { result_id: "old" });
    });
    vi.setSystemTime(BASE);
    await t.run(async (ctx) => {
      await ctx.db.insert("result_events", { result_id: "recent" });
    });

    const res = await t.mutation(internal.cleanup.sweepResultEvents, {});
    expect(res.deletedResultEvents).toBe(1);

    const remaining = await t.run(async (ctx) =>
      ctx.db.query("result_events").collect(),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].result_id).toBe("recent");
  });
});
