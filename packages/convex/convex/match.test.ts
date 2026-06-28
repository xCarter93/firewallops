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
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
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
