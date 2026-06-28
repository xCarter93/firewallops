import { describe, it, expect } from "vitest";

/**
 * RED until plan 04 — Wave-0 contract scaffold (05-VALIDATION.md); dynamic
 * import keeps collection/typecheck green.
 *
 * LOBBY-04: pins the `shouldAutoStart(mobileCount, teamSize, readyFlags)`
 * auto-start gate — fires ONLY when seats are full AND every mobile is ready —
 * BEFORE plan 04 ADDS the export to the EXISTING `@firewallops/match-core`
 * turnMachine module.
 *
 * Because `@firewallops/match-core` ALREADY resolves today, a top-level static
 * import would NOT be RED. So the new export is reached via a dynamic
 * `await import("@firewallops/match-core")` INSIDE the test body and read
 * through a local interface (`AutoStartModule`) that types the not-yet-added
 * export as OPTIONAL — that keeps `tsc` green (no TS2339 for the missing
 * property) while the runtime value is `undefined` until plan 04 lands. The
 * `expect(shouldAutoStart).toBeTypeOf("function")` guard therefore FAILS RED
 * until the real implementation is added — failing for the RIGHT reason (export
 * not built yet), then the behavioral cases pin the gate logic.
 */

/** The export plan 04 must ADD to turnMachine.ts (optional → typecheck-safe). */
interface AutoStartModule {
  shouldAutoStart?: (
    mobileCount: number,
    teamSize: number,
    readyFlags: boolean[],
  ) => boolean;
}

describe("auto-start", () => {
  it("fires only when seats are full AND all mobiles are ready (LOBBY-04)", async () => {
    const mod = (await import("@firewallops/match-core")) as AutoStartModule;
    const shouldAutoStart = mod.shouldAutoStart;

    // RED until plan 04 adds the export: undefined → fails this guard.
    expect(shouldAutoStart).toBeTypeOf("function");

    // Behavioral contract (runs once plan 04 lands the function).
    // teamSize 1 → 2 seats. Full + all ready → true.
    expect(shouldAutoStart!(2, 1, [true, true])).toBe(true);
    // Full seats + one not ready → false.
    expect(shouldAutoStart!(2, 1, [true, false])).toBe(false);
    // Not-full seats + all ready → false.
    expect(shouldAutoStart!(1, 1, [true])).toBe(false);
  });
});
