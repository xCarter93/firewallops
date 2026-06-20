import { describe, it, expect } from "vitest";
import { getLoadout } from "../src/meta/loadout.js";
import { recordMatchResult } from "../src/meta/results.js";
import { loadoutHandler, matchResultsHandler } from "../src/meta/routes.js";

/**
 * (stubs) Wave 0 coverage for the three passthrough Meta-API seams — the pure
 * stub logic AND the route handlers, exercised HEADLESSLY (no live WS/HTTP
 * server, no `app.listen`).
 */
describe("stub: loadout / results pure logic", () => {
  it("getLoadout returns the default items including shot-1 for any id", () => {
    const out = getLoadout("any-id");
    expect(out.items).toContain("shot-1");
    expect(out.items).toContain("shot-2");
    expect(out.items).toContain("trojan");
  });

  it("recordMatchResult accepts a payload and returns undefined (no throw)", () => {
    expect(recordMatchResult({ winnerTeam: 0 })).toBeUndefined();
  });
});

describe("stub: route handlers (headless, no Express)", () => {
  it("loadoutHandler calls res.json with items including shot-1", () => {
    let captured: { items?: readonly string[] } | undefined;
    loadoutHandler(
      { params: { accountId: "guest-x" } },
      { json: (b) => (captured = b as { items: readonly string[] }) },
    );
    expect(captured?.items).toContain("shot-1");
  });

  it("matchResultsHandler calls res.sendStatus(200) for a posted body", () => {
    let status: number | undefined;
    matchResultsHandler(
      { body: { winnerTeam: 1 } },
      { sendStatus: (n) => (status = n) },
    );
    expect(status).toBe(200);
  });
});
