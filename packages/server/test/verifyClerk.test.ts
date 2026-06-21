import { describe, it, expect, vi } from "vitest";

/**
 * RED until plan 03 — Wave-0 contract scaffold (05-VALIDATION.md); dynamic
 * import keeps collection/typecheck green.
 *
 * AUTH-03: pins the `verifyClerk(token)` contract — name, signature, and the
 * `{ accountId, sessionId }` mapping derived from Clerk's `{ sub, sid }` —
 * BEFORE plan 03 writes `src/auth/clerk.js`. The not-yet-built symbol is reached
 * ONLY via a dynamic `await import("../src/auth/clerk.js")` INSIDE the test body
 * (NEVER a top-level static import), and the future module path carries a
 * `@ts-expect-error` so `tsc` stays green until the file exists (Blocker 4).
 * The `await import` REJECTS (module not found) until plan 03 lands, so each test
 * is meaningfully RED for the RIGHT reason — the symbol is not built yet, not a
 * typo. RED→GREEN handoff: when plan 03 creates `src/auth/clerk.js`, it MUST
 * delete the two `@ts-expect-error` lines below (the suppressed error vanishes,
 * so the directive would otherwise become an "unused expectation").
 *
 * The upstream Clerk SDK (`@clerk/backend`, not installed until plan 03) is
 * mocked via `vi.mock` with a `vi.hoisted` handle — `vi.mock(specifier, factory)`
 * takes the specifier as a plain string, so `tsc` does NOT resolve it (no
 * TS2307 for the not-yet-installed package). We never statically/dynamically
 * `import` from `@clerk/backend` here, which is what keeps typecheck green even
 * though the package is absent.
 */

const { verifyTokenMock } = vi.hoisted(() => ({ verifyTokenMock: vi.fn() }));
vi.mock("@clerk/backend", () => ({ verifyToken: verifyTokenMock }));

/** The contract plan 03 must satisfy (pinned here, asserted via the import). */
type VerifyClerk = (
  token: string,
) => Promise<{ accountId: string; sessionId: string }>;

describe("verifyClerk", () => {
  it("maps a verified token's { sub, sid } to { accountId, sessionId } (AUTH-03)", async () => {
    verifyTokenMock.mockResolvedValue({ sub: "user_123", sid: "sess_1" });

    // GREEN: plan 03 created src/auth/clerk.ts → this import resolves.
    const mod = await import("../src/auth/clerk.js");
    const verifyClerk = mod.verifyClerk as VerifyClerk;

    await expect(verifyClerk("tok")).resolves.toEqual({
      accountId: "user_123",
      sessionId: "sess_1",
    });
  });

  it("rejects when the underlying verifyToken rejects (AUTH-03)", async () => {
    verifyTokenMock.mockRejectedValue(new Error("bad token"));

    const mod = await import("../src/auth/clerk.js");
    const verifyClerk = mod.verifyClerk as VerifyClerk;

    await expect(verifyClerk("tok")).rejects.toThrow();
  });
});
