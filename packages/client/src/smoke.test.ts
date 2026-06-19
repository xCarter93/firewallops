import { describe, it, expect } from "vitest";
import { powerToSpeed } from "@shared/sim";

// A2 de-risk (symbol-resolution proof): this test resolves a REAL @shared/sim
// runtime symbol from the client workspace under Vitest's bare-Node module
// resolution — the same path Vite uses. powerToSpeed(100) = 100 * 2.4 * 1 = 240
// (ballistics.ts POWER_TO_SPEED base, default powerScale 1).
describe("@shared/sim resolves from packages/client", () => {
  it("imports and runs powerToSpeed", () => {
    expect(powerToSpeed(100)).toBe(240);
  });
});
