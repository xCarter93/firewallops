import { describe, it, expect } from "vitest";
import {
  fireSchema,
  aimSchema,
  selectItemSchema,
  resetRangeSchema,
} from "@firewallops/match-core";

/**
 * NET-07 — the exported message schemas reject malformed / out-of-range /
 * unknown-itemId input BEFORE any Room logic. Tested headlessly (no Room): the
 * schema IS the boundary, so a `.safeParse` failure is exactly what the
 * `validate(...)` layer drops in the Room.
 */
describe("messages: validate rejects out-of-range / malformed / unknown input (NET-07)", () => {
  it("fireSchema rejects power > 100", () => {
    const r = fireSchema.safeParse({ angleDeg: 0, power: 101, itemId: "shot-1" });
    expect(r.success).toBe(false);
  });

  it("fireSchema rejects a non-finite (NaN) angle", () => {
    const r = fireSchema.safeParse({ angleDeg: NaN, power: 50, itemId: "shot-1" });
    expect(r.success).toBe(false);
  });

  it("fireSchema rejects an Infinity power", () => {
    const r = fireSchema.safeParse({
      angleDeg: 45,
      power: Infinity,
      itemId: "shot-1",
    });
    expect(r.success).toBe(false);
  });

  it("fireSchema rejects an unknown itemId (not in the enum allow-list)", () => {
    const r = fireSchema.safeParse({ angleDeg: 0, power: 50, itemId: "rocket" });
    expect(r.success).toBe(false);
  });

  it("fireSchema rejects a malformed (string) power", () => {
    const r = fireSchema.safeParse({ angleDeg: 0, power: "x", itemId: "shot-1" });
    expect(r.success).toBe(false);
  });

  it("fireSchema rejects an out-of-range (negative) angle", () => {
    const r = fireSchema.safeParse({
      angleDeg: -5,
      power: 50,
      itemId: "shot-1",
    });
    expect(r.success).toBe(false);
  });

  it("fireSchema accepts a valid payload", () => {
    const r = fireSchema.safeParse({ angleDeg: 45, power: 50, itemId: "shot-1" });
    expect(r.success).toBe(true);
  });

  it("aimSchema accepts an optional committed flag and rejects NaN", () => {
    expect(
      aimSchema.safeParse({ angleDeg: 90, power: 30, committed: true }).success,
    ).toBe(true);
    expect(aimSchema.safeParse({ angleDeg: 90, power: 30 }).success).toBe(true);
    expect(
      aimSchema.safeParse({ angleDeg: NaN, power: 30 }).success,
    ).toBe(false);
  });

  it("selectItemSchema enforces the itemId allow-list", () => {
    expect(selectItemSchema.safeParse({ itemId: "trojan" }).success).toBe(true);
    expect(selectItemSchema.safeParse({ itemId: "nuke" }).success).toBe(false);
  });

  it("resetRangeSchema accepts an absent/empty payload AND rejects unknown keys (.strict().optional())", () => {
    // Absent payload accepted — the payload-less client send (`room.send("resetRange")`).
    expect(resetRangeSchema.safeParse(undefined).success).toBe(true);
    // Empty object accepted.
    expect(resetRangeSchema.safeParse({}).success).toBe(true);
    // Unknown key REJECTED by `.strict()` (a non-strict z.object({}).optional()
    // would STRIP it and pass — this assertion proves the fix).
    expect(resetRangeSchema.safeParse({ foo: 1 }).success).toBe(false);
  });
});
