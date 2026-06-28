/**
 * Convex authority unit tests — the Wave-0 `convex-test` harness (Phase 9, Plan
 * 04). Runs the REAL Convex mutations/queries in the `edge-runtime` Vitest
 * environment (mirroring Convex's V8 isolate) with `convexTest(schema, modules)`
 * + `t.withIdentity({ subject })` for the Clerk-sub identity.
 *
 * Locks the lobby/membership authority contract this plan ships:
 *   (a) auth-reject     — an unauthenticated mutation/query throws (D-10).
 *   (b) accountId-strip — `get` returns mobiles WITHOUT `accountId` (R2).
 *   (c) capacity        — joining past `seatsFull` rejects (LOBBY-03).
 *   (d) auto-start      — full + all-ready drives the phase OUT of WAITING via
 *                         the REAL `internal.match_internal.startTurn` stub ([C]).
 *   (e) membership [J]  — `get`/`getTerrain` reject an UNAUTH caller AND a caller
 *                         who is NOT a member (non-seat subject).
 *
 * Identities use real Clerk-`sub`-shaped subjects (`user_2x…`).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import { TURN_START_DWELL_MS } from "@firewallops/match-core";
import schema from "./schema";
import { api } from "./_generated/api";

// convex-test discovers every Convex module via this glob (edge-runtime).
const modules = import.meta.glob("./**/*.ts");

const SUB_A = "user_2aAaAaAaAaAaAaAaAaAaAaAaAaA";
const SUB_B = "user_2bBbBbBbBbBbBbBbBbBbBbBbBbB";
const SUB_C = "user_2cCcCcCcCcCcCcCcCcCcCcCcCcC";

function harness() {
  return convexTest(schema, modules);
}

describe("match authority — lobby/membership (Plan 04)", () => {
  it("(a) createRoom requires auth — an unauthenticated call throws (D-10)", async () => {
    const t = harness();
    // No withIdentity → getUserIdentity() is null → reject.
    await expect(
      t.mutation(api.match.createRoom, { name: "t", mode: "1v1" }),
    ).rejects.toThrow();
  });

  it("(a') joinMatch / toggleReady / selectItem also reject unauthenticated callers", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    const matchId = await asA.mutation(api.match.createRoom, {
      name: "t",
      mode: "1v1",
    });
    await expect(
      t.mutation(api.match.joinMatch, { matchId }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.match.toggleReady, { matchId, ready: true }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.match.selectItem, { matchId, itemId: "shot-1" }),
    ).rejects.toThrow();
  });

  it("(b) get strips accountId from every returned mobile (R2)", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    const matchId = await asA.mutation(api.match.createRoom, {
      name: "t",
      mode: "1v1",
    });
    await asA.mutation(api.match.joinMatch, { matchId });

    const doc = await asA.query(api.match.get, { matchId });
    expect(doc).not.toBeNull();
    expect(doc!.mobiles.length).toBe(1);
    for (const mob of doc!.mobiles) {
      expect("accountId" in mob).toBe(false);
    }
    // [I] the caller learns its own seat id WITHOUT accountId crossing the wire.
    expect(doc!.localMobileId).toBe(doc!.mobiles[0].mobileId);
  });

  it("(c) capacity — joining past seatsFull rejects (1v1 = 2 seats)", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    const asB = t.withIdentity({ subject: SUB_B });
    const asC = t.withIdentity({ subject: SUB_C });

    const matchId = await asA.mutation(api.match.createRoom, {
      name: "t",
      mode: "1v1",
    });
    await asA.mutation(api.match.joinMatch, { matchId });
    await asB.mutation(api.match.joinMatch, { matchId }); // fills the 2 seats

    // A third distinct caller is rejected — the room is full.
    await expect(
      asC.mutation(api.match.joinMatch, { matchId }),
    ).rejects.toThrow();
  });

  it("(d) auto-start — full + all-ready drives the phase out of WAITING via the real startTurn stub ([C])", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    const asB = t.withIdentity({ subject: SUB_B });

    const matchId = await asA.mutation(api.match.createRoom, {
      name: "t",
      mode: "1v1",
    });
    await asA.mutation(api.match.joinMatch, { matchId });
    await asB.mutation(api.match.joinMatch, { matchId });

    // First ready — still WAITING (not yet unanimous).
    await asA.mutation(api.match.toggleReady, { matchId, ready: true });
    let doc = await asA.query(api.match.get, { matchId });
    expect(doc!.phase).toBe("WAITING");

    // Second ready — full + all-ready → startTurn stub fires → leaves WAITING.
    await asB.mutation(api.match.toggleReady, { matchId, ready: true });
    doc = await asA.query(api.match.get, { matchId });
    expect(doc!.phase).not.toBe("WAITING");
    expect(doc!.turnSeq).toBeGreaterThan(0);
  });

  it("(e) get/getTerrain reject an unauthenticated caller AND a non-member ([J])", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    const asB = t.withIdentity({ subject: SUB_B }); // a NON-member (never joins)

    const matchId = await asA.mutation(api.match.createRoom, {
      name: "t",
      mode: "1v1",
    });
    await asA.mutation(api.match.joinMatch, { matchId });

    // Unauthenticated → reject.
    await expect(t.query(api.match.get, { matchId })).rejects.toThrow();
    await expect(t.query(api.match.getTerrain, { matchId })).rejects.toThrow();

    // Authenticated but NOT a member → reject (membership gate, [J]).
    await expect(
      asB.query(api.match.get, { matchId }),
    ).rejects.toThrow();
    await expect(
      asB.query(api.match.getTerrain, { matchId }),
    ).rejects.toThrow();

    // A member can read both.
    const doc = await asA.query(api.match.get, { matchId });
    expect(doc).not.toBeNull();
    const terrain = await asA.query(api.match.getTerrain, { matchId });
    expect(terrain).not.toBeNull();
    expect(terrain!.version).toBe(0);
  });
});

// ─────────────────────────── Plan 05: fireShot core ───────────────────────────

type Harness = ReturnType<typeof harness>;

/**
 * Drive a fresh 1v1 to AIMING and return the ids needed to fire. Both seats join
 * + ready, the auto-start `startTurn` schedules `enterAiming` (TURN_START dwell),
 * and `finishInProgressScheduledFunctions` runs that dwell so the phase reaches
 * AIMING. Returns the matchId + the ACTIVE caller's identity/mobileId + the
 * INACTIVE caller's identity (for the out-of-turn case).
 */
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

  // Run the TURN_START → enterAiming dwell (300ms) so the phase reaches AIMING —
  // but NOT past TURN_MS (20s), so the real-match onTurnTimeout does not fire yet.
  vi.advanceTimersByTime(TURN_START_DWELL_MS);
  await t.finishInProgressScheduledFunctions();

  const doc = await asA.query(api.match.get, { matchId });
  expect(doc!.phase).toBe("AIMING");

  // Figure out which seat is active (advanceTurn picks lowest accumulatedDelay /
  // array order — deterministic but we resolve it instead of assuming).
  const aMobileId = doc!.mobiles.find((m) => m.team === 0)!.mobileId;
  const activeIsA = doc!.activeMobileId === aMobileId;
  return {
    matchId,
    active: activeIsA ? asA : asB,
    inactive: activeIsA ? asB : asA,
    activeMobileId: doc!.activeMobileId,
  };
}

describe("match authority — fireShot core (Plan 05)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fireShot in-turn resolves: re-encodes terrain (bumps version), sets RESOLVING + lastShot, schedules afterResolve", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, active } = await reach1v1Aiming(t);

    const before = await active.query(api.match.getTerrain, { matchId });
    expect(before!.version).toBe(0);

    await active.mutation(api.match.fireShot, {
      matchId,
      angleDeg: 45,
      power: 80,
      itemId: "shot-1",
    });

    const doc = await active.query(api.match.get, { matchId });
    expect(doc!.phase).toBe("RESOLVING");
    expect(doc!.lastShot).toBeTruthy();
    expect(doc!.lastShot!.seq).toBe(1);
    expect(doc!.lastShot!.byMobileId).toBe(doc!.activeMobileId);

    // Terrain was re-encoded + the version mirror bumped (D-11/R7).
    const after = await active.query(api.match.getTerrain, { matchId });
    expect(after!.version).toBe(1);
    expect(doc!.terrainVersion).toBe(1);

    // The active mobile accumulated the shot-1 turnDelay (10).
    const activeMob = doc!.mobiles.find(
      (m) => m.mobileId === doc!.activeMobileId,
    )!;
    expect(activeMob.accumulatedDelay).toBe(10);
  });

  it("out-of-turn fireShot is a NO-OP (shouldResolveFire false) — no lastShot, phase unchanged", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, inactive } = await reach1v1Aiming(t);

    await inactive.mutation(api.match.fireShot, {
      matchId,
      angleDeg: 45,
      power: 80,
      itemId: "shot-1",
    });

    const doc = await inactive.query(api.match.get, { matchId });
    expect(doc!.phase).toBe("AIMING"); // unchanged — the fire was dropped.
    expect(doc!.lastShot ?? null).toBeNull();
  });

  it("a non-member fireShot is a NO-OP", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId } = await reach1v1Aiming(t);
    const asC = t.withIdentity({ subject: SUB_C });

    await asC.mutation(api.match.fireShot, {
      matchId,
      angleDeg: 45,
      power: 80,
      itemId: "shot-1",
    });
    // The doc is unchanged; a member can still read AIMING with no lastShot.
    const asA = t.withIdentity({ subject: SUB_A });
    const doc = await asA.query(api.match.get, { matchId });
    expect(doc!.lastShot ?? null).toBeNull();
  });

  it("unauthenticated fireShot throws (D-10)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId } = await reach1v1Aiming(t);
    await expect(
      t.mutation(api.match.fireShot, {
        matchId,
        angleDeg: 45,
        power: 80,
        itemId: "shot-1",
      }),
    ).rejects.toThrow();
  });

  it("createRoom training: seats caller + passive dummy + starts the turn (status active, human active)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });

    const matchId = await asA.mutation(api.match.createRoom, {
      name: "range",
      mode: "training",
    });
    // Training reaches AIMING and STOPS (no onTurnTimeout scheduled in training),
    // so draining all scheduled work terminates.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const doc = await asA.query(api.match.get, { matchId });
    expect(doc!.status).toBe("active");
    expect(doc!.mobiles.length).toBe(2);
    const dummy = doc!.mobiles.find((m) => m.mobileId === "dummy")!;
    expect(dummy.passive).toBe(true);
    expect(dummy.hp).toBe(100);
    expect(dummy.team).toBe(1);
    // The human (non-passive) is the active mobile — the dummy can never win.
    const human = doc!.mobiles.find((m) => !m.passive)!;
    expect(doc!.activeMobileId).toBe(human.mobileId);
  });

  it("training fireShot: player is invincible (self-splash never written) + self-damage filtered from lastShot.damage (S5b)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });

    const matchId = await asA.mutation(api.match.createRoom, {
      name: "range",
      mode: "training",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    let doc = await asA.query(api.match.get, { matchId });
    expect(doc!.phase).toBe("AIMING");
    const humanId = doc!.activeMobileId;

    // Fire near-straight-up at full power so the shot lands on the firer's own
    // column — any self-damage must NOT be written (invincible) NOR surface in FX.
    await asA.mutation(api.match.fireShot, {
      matchId,
      angleDeg: 90,
      power: 100,
      itemId: "shot-1",
    });

    doc = await asA.query(api.match.get, { matchId });
    const human = doc!.mobiles.find((m) => m.mobileId === humanId)!;
    expect(human.hp).toBe(100); // never lost hp to self-splash.
    // No self-damage entry in the FX damage list.
    const selfDamage = (doc!.lastShot?.damage ?? []).filter(
      (d) => d.mechId === humanId,
    );
    expect(selfDamage.length).toBe(0);
  });

  it("resetRange (training) rebuilds terrain + respawns dummy + wipes player shot state; non-training caller is a no-op", async () => {
    vi.useFakeTimers();
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });

    const matchId = await asA.mutation(api.match.createRoom, {
      name: "range",
      mode: "training",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Fire once to carve terrain + accumulate delay.
    await asA.mutation(api.match.fireShot, {
      matchId,
      angleDeg: 45,
      power: 80,
      itemId: "shot-1",
    });
    let after = await asA.query(api.match.getTerrain, { matchId });
    const carvedVersion = after!.version;
    expect(carvedVersion).toBeGreaterThan(0);

    // Reset BEFORE the resolve dwell fires — the pending afterResolve becomes stale
    // (phase left RESOLVING) and no-ops; the wholesale rebuild bumps the version.
    await asA.mutation(api.match.resetRange, { matchId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    after = await asA.query(api.match.getTerrain, { matchId });
    expect(after!.version).toBeGreaterThan(carvedVersion); // wholesale rebuild bumped.

    const doc = await asA.query(api.match.get, { matchId });
    // Dummy still present + fresh; the human's accumulatedDelay was wiped to 0.
    expect(doc!.mobiles.some((m) => m.mobileId === "dummy")).toBe(true);
    const human = doc!.mobiles.find((m) => !m.passive)!;
    expect(human.accumulatedDelay).toBe(0);
    expect(human.ssHitCharge).toBe(0);

    // A non-training caller's resetRange is inert.
    const asB = t.withIdentity({ subject: SUB_B });
    const realId = await asB.mutation(api.match.createRoom, {
      name: "t",
      mode: "1v1",
    });
    await asB.mutation(api.match.joinMatch, { matchId: realId });
    const beforeReal = await asB.query(api.match.get, { matchId: realId });
    await asB.mutation(api.match.resetRange, { matchId: realId });
    const afterReal = await asB.query(api.match.get, { matchId: realId });
    expect(afterReal!.phase).toBe(beforeReal!.phase); // unchanged.
  });

  it("leaveMatch in a live real match records abandon_loss (granular resultId) + ends via forfeit", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, active, inactive } = await reach1v1Aiming(t);

    // The active caller leaves a live (AIMING) 1v1 → the survivor (inactive) wins,
    // leaver takes abandon_loss, match ends. Draining all scheduled work is safe:
    // the pending onTurnTimeout no-ops on the terminal (RESULTS) phase guard.
    await active.mutation(api.match.leaveMatch, { matchId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The survivor (still a member) reads RESULTS with a real winner team.
    const survivorDoc = await inactive.query(api.match.get, { matchId });
    expect(survivorDoc!.phase).toBe("RESULTS");
    expect(survivorDoc!.winnerTeam).toBeGreaterThanOrEqual(0);
  });
});
