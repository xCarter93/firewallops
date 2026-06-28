/**
 * Convex authed Meta-API unit tests — the Meta-API migration off REST (Phase 9,
 * Plan 09-11, review [A1]). Runs the REAL Convex queries/mutations in the
 * `edge-runtime` Vitest environment via `convexTest(schema, modules)` +
 * `t.withIdentity({ subject })` for the Clerk-sub identity (same harness as
 * match.test.ts).
 *
 * Locks the authed-profile + loadout authority contract this plan ships:
 *   (a) getMyProfile    — returns the AUTHED subject's row; rejects unauthenticated.
 *   (b) setMyDisplayName — writes for the identity subject; rejects empty; ignores
 *                          any client-supplied id (the only arg is `displayName`,
 *                          so a foreign id is structurally impossible — D-08/T-09-26).
 *   (c) loadout.get     — returns the three default items; rejects unauthenticated.
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

function harness() {
  return convexTest(schema, modules);
}

describe("accounts authed profile (Plan 09-11, review [A1])", () => {
  it("(a) getMyProfile returns the authed subject's row", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });

    // Provision A's row, then set a handle for A.
    await t.mutation(api.accounts.provision, { authUserId: SUB_A });
    await asA.mutation(api.accounts.setMyDisplayName, { displayName: "N1GHTW1RE" });

    const row = await asA.query(api.accounts.getMyProfile, {});
    expect(row).not.toBeNull();
    expect(row!.auth_user_id).toBe(SUB_A);
    expect(row!.display_name).toBe("N1GHTW1RE");
  });

  it("(a') getMyProfile returns null when the caller has no row yet", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    const row = await asA.query(api.accounts.getMyProfile, {});
    expect(row).toBeNull();
  });

  it("(a'') getMyProfile rejects an unauthenticated caller (no leak)", async () => {
    const t = harness();
    await expect(t.query(api.accounts.getMyProfile, {})).rejects.toThrow();
  });

  it("(a''') getMyProfile reads ONLY the caller's own row (no cross-account read)", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    const asB = t.withIdentity({ subject: SUB_B });

    await asA.mutation(api.accounts.setMyDisplayName, { displayName: "AAA" });
    await asB.mutation(api.accounts.setMyDisplayName, { displayName: "BBB" });

    // Each subject sees only their OWN row, keyed off identity (T-09-28).
    expect((await asA.query(api.accounts.getMyProfile, {}))!.display_name).toBe(
      "AAA",
    );
    expect((await asB.query(api.accounts.getMyProfile, {}))!.display_name).toBe(
      "BBB",
    );
  });

  it("(b) setMyDisplayName writes for the identity subject", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });

    await asA.mutation(api.accounts.setMyDisplayName, { displayName: "GH0ST" });

    // The write landed on A's row (verified subject), readable via the authed read.
    const row = await asA.query(api.accounts.getMyProfile, {});
    expect(row!.auth_user_id).toBe(SUB_A);
    expect(row!.display_name).toBe("GH0ST");
  });

  it("(b') setMyDisplayName rejects an empty / whitespace-only handle", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    await expect(
      asA.mutation(api.accounts.setMyDisplayName, { displayName: "" }),
    ).rejects.toThrow();
    await expect(
      asA.mutation(api.accounts.setMyDisplayName, { displayName: "   " }),
    ).rejects.toThrow();
  });

  it("(b'') setMyDisplayName rejects an oversized handle", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    await expect(
      asA.mutation(api.accounts.setMyDisplayName, {
        displayName: "X".repeat(25),
      }),
    ).rejects.toThrow();
  });

  it("(b''') setMyDisplayName rejects an unauthenticated caller", async () => {
    const t = harness();
    await expect(
      t.mutation(api.accounts.setMyDisplayName, { displayName: "NOPE" }),
    ).rejects.toThrow();
  });

  it("(b'''') setMyDisplayName accepts ONLY displayName — a smuggled id-shaped field is rejected by the validator (D-08)", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });

    // The mutation args are strictly `{ displayName }`. A caller cannot even pass
    // an id-shaped field — the Convex validator rejects unknown args outright — so
    // the write can ONLY key off the verified subject, never the body (T-09-26).
    await expect(
      asA.mutation(api.accounts.setMyDisplayName, {
        displayName: "MINE",
        // @ts-expect-error — authUserId is NOT an accepted arg (D-08).
        authUserId: SUB_B,
      }),
    ).rejects.toThrow();

    // A clean write keys off the subject; B's row is never created by A's call.
    await asA.mutation(api.accounts.setMyDisplayName, { displayName: "MINE" });
    expect((await asA.query(api.accounts.getMyProfile, {}))!.display_name).toBe(
      "MINE",
    );
    const asB = t.withIdentity({ subject: SUB_B });
    expect(await asB.query(api.accounts.getMyProfile, {})).toBeNull();
  });
});

describe("loadout.get (Plan 09-11, review [A1])", () => {
  it("(c) returns the three default items for an authed caller", async () => {
    const t = harness();
    const asA = t.withIdentity({ subject: SUB_A });
    const loadout = await asA.query(api.loadout.get, {});
    expect(loadout).toEqual({ items: ["shot-1", "shot-2", "trojan"] });
  });

  it("(c') rejects an unauthenticated caller", async () => {
    const t = harness();
    await expect(t.query(api.loadout.get, {})).rejects.toThrow();
  });
});
