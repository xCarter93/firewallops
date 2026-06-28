import { describe, it, expect } from "vitest";
import { seatsFull, shouldAutoStart, teamSizeForMode } from "@firewallops/match-core";

/**
 * Room-capacity discipline (review HIGH) — LOBBY-03 / LOBBY-04.
 *
 * Locks, at the PURE-helper level, the contract the MatchRoom delegates to:
 *   - mode → teamSize → maxClients (= teamSize * 2),
 *   - `seatsFull` is the lock-on-full / reject-late-join boundary,
 *   - and lock-on-full is INDEPENDENT of ready (`shouldAutoStart`): a full room
 *     is locked (admits no further client) even when not all-ready, while the
 *     gate only STARTS once full && all-ready.
 *
 * The WS-level reject (onJoin → client.leave on a full room) is covered by the
 * manual UAT; this test pins the helper math the room relies on.
 */
describe("room capacity", () => {
  it("1v1: maxClients = teamSize*2 = 2; full at 2 seats, not at 1", () => {
    expect(teamSizeForMode("1v1")).toBe(1);
    expect(teamSizeForMode("1v1") * 2).toBe(2);
    expect(seatsFull(2, 1)).toBe(true);
    expect(seatsFull(1, 1)).toBe(false);
  });

  it("2v2: maxPlayers = 4; full at 4 seats, not at 3", () => {
    expect(teamSizeForMode("2v2")).toBe(2);
    expect(teamSizeForMode("2v2") * 2).toBe(4);
    expect(seatsFull(4, 2)).toBe(true);
    expect(seatsFull(3, 2)).toBe(false);
  });

  it("4v4: maxPlayers = 8; full at 8 seats, not at 7", () => {
    expect(teamSizeForMode("4v4")).toBe(4);
    expect(teamSizeForMode("4v4") * 2).toBe(8);
    expect(seatsFull(8, 4)).toBe(true);
    expect(seatsFull(7, 4)).toBe(false);
  });

  it("training: single human seat — teamSize 1, maxClients hard-capped to 1 (not teamSize*2)", () => {
    // teamSize is 1 (one human seat). NOTE: training caps occupancy via
    // `maxClients = 1` set on the Room (Plan 02), NOT via `seatsFull` (which would
    // compute teamSize*2 = 2 — that's the dummy slot, not a second human). We lock
    // only the teamSize here; the room-level maxClients cap is asserted in Plan 02.
    expect(teamSizeForMode("training")).toBe(1);
  });

  it("full-but-not-all-ready: room is full (locked, admits no client) yet does NOT auto-start", () => {
    // Full (lock-on-full applies — the room admits no further client)…
    expect(seatsFull(2, 1)).toBe(true);
    // …but one seat unready → the auto-start gate is false (no start).
    expect(shouldAutoStart(2, 1, [true, false])).toBe(false);
    // Locking on full is independent of ready; starting requires unanimous ready.
    expect(shouldAutoStart(2, 1, [true, true])).toBe(true);
  });
});
