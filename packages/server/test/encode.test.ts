import { describe, it, expect } from "vitest";
import { Encoder, Decoder } from "@colyseus/schema";
import { MatchState, Mobile } from "../src/rooms/schema/MatchState.js";

/**
 * REGRESSION (the bug the two-tab NET-06 test caught): the server crashed on the
 * first full-state send to a joining client —
 *   TypeError: Cannot read properties of undefined (reading 'Symbol(Symbol.metadata)')
 *   at encodeValue ... SchemaSerializer.getFullState ... MatchRoom.sendFullState
 * — because the ES2022 default `useDefineForClassFields: true` emitted the
 * `mobiles = new MapSchema<Mobile>()` field initializer as `Object.defineProperty`,
 * which BYPASSES @colyseus/schema's legacy `@type()` setter, so the MapSchema's
 * child type ($childType = Mobile) was never registered. The encoder then read an
 * `undefined` field type and threw. Fixed by `useDefineForClassFields: false` in
 * packages/server/tsconfig.json.
 *
 * No prior test exercised ENCODING (schema.test only checked construction +
 * field defaults), so the bug only surfaced on a live join. This test mirrors
 * Colyseus's getFullState (Encoder.encodeAll) + a client-side Decoder so any
 * future regression of the decorator/tsconfig setup fails headlessly in CI.
 */
describe("schema full-state encode/decode round-trip (regression: MapSchema child type)", () => {
  it("encodes a populated MatchState and a client decodes mobiles + nested fields", () => {
    const state = new MatchState();
    state.phase = "AIMING";
    state.activePlayer = "p1";
    state.wind = 12;
    state.turnEndsAt = 20_000;

    const a = new Mobile();
    a.sessionId = "p1";
    a.team = 0;
    a.x = 300;
    a.y = 400;
    a.hp = 100;
    a.angleDeg = 45;
    a.facing = 1;
    state.mobiles.set("p1", a);

    const b = new Mobile();
    b.sessionId = "p2";
    b.team = 1;
    b.x = 1700;
    b.y = 410;
    b.hp = 80;
    b.facing = -1;
    b.ssHitCharge = 2;
    state.mobiles.set("p2", b);

    // Encode the FULL state — this is the exact call (Encoder.encodeAll) that
    // SchemaSerializer.getFullState makes when a client joins.
    const encoder = new Encoder(state);
    const bytes = encoder.encodeAll();
    expect(bytes.byteLength).toBeGreaterThan(0);

    // Decode into a fresh client-side replica.
    const decoded = new MatchState();
    const decoder = new Decoder(decoded);
    decoder.decode(bytes);

    expect(decoded.phase).toBe("AIMING");
    expect(decoded.activePlayer).toBe("p1");
    expect(decoded.wind).toBe(12);
    expect(decoded.mobiles.size).toBe(2);
    expect(decoded.mobiles.get("p1")!.hp).toBe(100);
    expect(decoded.mobiles.get("p1")!.team).toBe(0);
    expect(decoded.mobiles.get("p2")!.hp).toBe(80);
    expect(decoded.mobiles.get("p2")!.team).toBe(1);
    expect(decoded.mobiles.get("p2")!.facing).toBe(-1);
    expect(decoded.mobiles.get("p2")!.ssHitCharge).toBe(2);
  });
});
