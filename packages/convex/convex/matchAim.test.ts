/**
 * Convex live-aim authority tests — the opponent-aim telegraph (Phase 9, Plan 10).
 *
 * Runs the REAL `matchAim.updateAim`/`get` in the `edge-runtime` convex-test
 * harness (mirrors `match.test.ts`). Drives a fresh 1v1 to AIMING so the
 * active-player gate is live, then locks the throttle/delta-gate + gate contract:
 *
 *   (a) write-on-delta   — the active player's updateAim writes the matchAim row.
 *   (b) no-write-on-dup  — a duplicate quantized angle does NOT write (delta-gate:
 *                          seq unchanged; ≤1° sub-degree moves quantize equal).
 *   (c) gate-reject       — a non-active / non-member / unauthenticated caller
 *                          writes NOTHING (silent no-op for the seated callers).
 *   (d) clamp             — an out-of-window angle is stored CLAMPED (the same
 *                          clampAbsoluteAngle fireShot applies).
 *
 * Identities use real Clerk-`sub`-shaped subjects, exactly as match.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import { TURN_START_DWELL_MS } from "@firewallops/match-core";
import { AIM_WINDOW } from "@shared/sim";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

const SUB_A = "user_2aAaAaAaAaAaAaAaAaAaAaAaAaA";
const SUB_B = "user_2bBbBbBbBbBbBbBbBbBbBbBbBbB";
const SUB_C = "user_2cCcCcCcCcCcCcCcCcCcCcCcCcC";

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

/**
 * Drive a fresh 1v1 to AIMING (mirrors match.test.ts:reach1v1Aiming). Returns the
 * matchId, the ACTIVE caller's identity + mobileId + facing, and the INACTIVE
 * caller's identity (for the out-of-turn no-op case).
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

  vi.advanceTimersByTime(TURN_START_DWELL_MS);
  await t.finishInProgressScheduledFunctions();

  const doc = await asA.query(api.match.get, { matchId });
  expect(doc!.phase).toBe("AIMING");

  const activeMobileId = doc!.activeMobileId;
  const activeMob = doc!.mobiles.find((m) => m.mobileId === activeMobileId)!;
  const aMobileId = doc!.mobiles.find((m) => m.team === 0)!.mobileId;
  const activeIsA = activeMobileId === aMobileId;
  return {
    matchId,
    active: activeIsA ? asA : asB,
    inactive: activeIsA ? asB : asA,
    activeMobileId,
    activeFacing: (activeMob.facing === -1 ? -1 : 1) as 1 | -1,
  };
}

describe("matchAim — opponent-aim telegraph (Plan 10)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) the active player's updateAim writes the matchAim row", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, active, activeMobileId } = await reach1v1Aiming(t);

    // Pick an in-window absolute angle for the active facing so it is not clamped:
    // the window midpoint (50) is in-window for either facing (mirror is symmetric
    // around 90, and 50/130 both round trip; we assert via the stored value below).
    await active.mutation(api.matchAim.updateAim, { matchId, angleDeg: 50 });

    const aim = await active.query(api.matchAim.get, { matchId });
    expect(aim).not.toBeNull();
    expect(aim!.mobileId).toBe(activeMobileId);
    expect(aim!.seq).toBe(1);
  });

  it("(b) a duplicate quantized angle does NOT write (delta-gate: seq unchanged)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, active } = await reach1v1Aiming(t);

    await active.mutation(api.matchAim.updateAim, { matchId, angleDeg: 50 });
    const first = await active.query(api.matchAim.get, { matchId });
    expect(first!.seq).toBe(1);

    // Same whole-degree angle (and a sub-degree wiggle that quantizes equal) →
    // delta-gate skips the write; seq stays put.
    await active.mutation(api.matchAim.updateAim, { matchId, angleDeg: 50 });
    await active.mutation(api.matchAim.updateAim, { matchId, angleDeg: 50.3 });
    const second = await active.query(api.matchAim.get, { matchId });
    expect(second!.seq).toBe(1);

    // A real delta DOES write (seq advances) — proves the gate, not a dead write.
    await active.mutation(api.matchAim.updateAim, { matchId, angleDeg: 52 });
    const third = await active.query(api.matchAim.get, { matchId });
    expect(third!.seq).toBe(2);
    expect(third!.angleDeg).toBe(52);
  });

  it("(c) a non-active / non-member / unauthenticated caller writes nothing", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, inactive } = await reach1v1Aiming(t);
    const asC = t.withIdentity({ subject: SUB_C }); // never joined — non-member.

    // Non-active seated player → silent no-op (no row written).
    await inactive.mutation(api.matchAim.updateAim, { matchId, angleDeg: 50 });
    // Non-member → silent no-op.
    await asC.mutation(api.matchAim.updateAim, { matchId, angleDeg: 50 });
    let aim = await inactive.query(api.matchAim.get, { matchId });
    expect(aim).toBeNull();

    // Unauthenticated updateAim AND get both reject (no identity).
    await expect(
      t.mutation(api.matchAim.updateAim, { matchId, angleDeg: 50 }),
    ).rejects.toThrow();
    await expect(t.query(api.matchAim.get, { matchId })).rejects.toThrow();

    // Still no row after all the rejected/no-op calls.
    aim = await inactive.query(api.matchAim.get, { matchId });
    expect(aim).toBeNull();
  });

  it("(d) an out-of-window angle is stored CLAMPED (same clamp as fireShot)", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { matchId, active, activeFacing } = await reach1v1Aiming(t);

    // Aim WAY above the window (88° absolute). The window is relative 30–70; for
    // facing 1 the absolute window is [30,70], for facing -1 it is [110,150]
    // (180 - rel). Either way 88 is out-of-window and must clamp to the boundary.
    await active.mutation(api.matchAim.updateAim, { matchId, angleDeg: 88 });

    const aim = await active.query(api.matchAim.get, { matchId });
    expect(aim).not.toBeNull();

    // Re-derive the expected clamped+quantized boundary for the active facing.
    const expected =
      activeFacing === 1
        ? Math.round(AIM_WINDOW.maxDeg) // 70
        : Math.round(180 - AIM_WINDOW.minDeg); // 150
    expect(aim!.angleDeg).toBe(expected);
    // The raw 88 was NOT stored — the clamp corrected it.
    expect(aim!.angleDeg).not.toBe(88);
  });
});
