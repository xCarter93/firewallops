import { describe, it, expect } from "vitest";
import {
  advanceTurn,
  checkWinTeam,
  assignTeam,
  seatsFull,
  timeoutOutcome,
  canFire,
  type TurnMobile,
} from "../src/match/turnMachine.js";
import { FORFEIT_DELAY } from "../src/config.js";

/**
 * Pure turn-machine coverage (NET-02 / NET-03 / NET-04). No live WS server — the
 * machine is pure functions over a plain-data view, so the gate, transitions,
 * win, forfeit decision, and auto-balance are all exercised headlessly.
 */

function mobile(over: Partial<TurnMobile> = {}): TurnMobile {
  return {
    sessionId: "x",
    team: 0,
    hp: 100,
    accumulatedDelay: 0,
    powerLocked: false,
    ...over,
  };
}

describe("turn machine: delay queue + win + balance", () => {
  it("turn machine advances to the lowest-delay living mech (skips dead, ties by order)", () => {
    const a = mobile({ sessionId: "a", accumulatedDelay: 30 });
    const b = mobile({ sessionId: "b", accumulatedDelay: 10 });
    const c = mobile({ sessionId: "c", accumulatedDelay: 20 });
    expect(advanceTurn([a, b, c])).toBe("b");

    // Dead mechs are skipped even with the lowest delay.
    const dead = mobile({ sessionId: "dead", accumulatedDelay: 0, hp: 0 });
    const live = mobile({ sessionId: "live", accumulatedDelay: 5 });
    expect(advanceTurn([dead, live])).toBe("live");

    // Ties break by array order (stable): first one wins.
    const t1 = mobile({ sessionId: "t1", accumulatedDelay: 7 });
    const t2 = mobile({ sessionId: "t2", accumulatedDelay: 7 });
    expect(advanceTurn([t1, t2])).toBe("t1");
  });

  it("advanceTurn throws when there is no living mech", () => {
    expect(() =>
      advanceTurn([mobile({ hp: 0 }), mobile({ hp: 0 })]),
    ).toThrow();
  });

  it("turn machine checkWinTeam returns ongoing then last team standing", () => {
    const a = mobile({ sessionId: "a", team: 0, hp: 100 });
    const b = mobile({ sessionId: "b", team: 1, hp: 100 });
    // Both teams alive → ongoing.
    expect(checkWinTeam([a, b])).toEqual({ kind: "ongoing" });

    // Kill team 1's only mech → team 0 wins.
    b.hp = 0;
    expect(checkWinTeam([a, b])).toEqual({ kind: "winner", team: 0 });
  });

  it("turn machine checkWinTeam returns a draw on mutual elimination", () => {
    // ALL mechs hp 0 → the simultaneous-wipe path is a defined draw, never
    // undefined (Codex MEDIUM).
    const a = mobile({ sessionId: "a", team: 0, hp: 0 });
    const b = mobile({ sessionId: "b", team: 1, hp: 0 });
    expect(checkWinTeam([a, b])).toEqual({ kind: "draw" });
  });

  it("assignTeam auto-balances by join order within teamSize", () => {
    // teamSize 2 → 4 seats fill A,B,A,B, both teams within size.
    expect(assignTeam(0, 2)).toBe(0);
    expect(assignTeam(1, 2)).toBe(1);
    expect(assignTeam(2, 2)).toBe(0);
    expect(assignTeam(3, 2)).toBe(1);
  });

  it("seatsFull is true exactly at teamSize*2 seats", () => {
    // 1v1: 2 total seats — full at 2, open at 0/1.
    expect(seatsFull(0, 1)).toBe(false);
    expect(seatsFull(1, 1)).toBe(false);
    expect(seatsFull(2, 1)).toBe(true);
    // 2v2: 4 total seats — full at 4, open at 3.
    expect(seatsFull(3, 2)).toBe(false);
    expect(seatsFull(4, 2)).toBe(true);
  });
});

describe("gate rejects out-of-turn and wrong-phase fire (NET-02)", () => {
  it("canFire is true only for the active player in the AIMING phase", () => {
    // Out-of-turn: a non-active sender is rejected even in AIMING.
    expect(canFire("AIMING", "other", "active")).toBe(false);
    // Wrong-phase: the active player is rejected outside AIMING.
    expect(canFire("RESOLVING", "active", "active")).toBe(false);
    expect(canFire("TURN_START", "active", "active")).toBe(false);
    // The only accepted case.
    expect(canFire("AIMING", "active", "active")).toBe(true);
  });
});

describe("forfeit auto-fires when power locked, skips otherwise (NET-04)", () => {
  it("timeoutOutcome is auto-fire when powerLocked, skip otherwise", () => {
    expect(timeoutOutcome(mobile({ powerLocked: true }))).toEqual({
      kind: "auto-fire",
    });
    expect(timeoutOutcome(mobile({ powerLocked: false }))).toEqual({
      kind: "skip",
    });
  });

  it("forfeit skip branch advances the turn and applies FORFEIT_DELAY (injected-clock integration)", () => {
    // A minimal Room-logic harness driven by the pure transition functions + a
    // fake clock: TURN_START → AIMING → (timeout) → verify advance + FORFEIT.
    type Scheduled = { fn: () => void; at: number };
    class FakeClock {
      currentTime = 0;
      private queue: Scheduled[] = [];
      setTimeout(fn: () => void, ms: number) {
        const entry = { fn, at: this.currentTime + ms };
        this.queue.push(entry);
        return { clear: () => {
          this.queue = this.queue.filter((e) => e !== entry);
        } };
      }
      advance(ms: number) {
        this.currentTime += ms;
        const due = this.queue.filter((e) => e.at <= this.currentTime);
        this.queue = this.queue.filter((e) => e.at > this.currentTime);
        for (const e of due) e.fn();
      }
    }

    const clock = new FakeClock();
    const mobiles: TurnMobile[] = [
      mobile({ sessionId: "a", accumulatedDelay: 0, powerLocked: false }),
      mobile({ sessionId: "b", accumulatedDelay: 5, powerLocked: false }),
    ];
    let phase = "WAITING";
    let activePlayer = "";

    const TURN_MS = 100;
    const onTimeout = () => {
      const active = mobiles.find((m) => m.sessionId === activePlayer)!;
      const outcome = timeoutOutcome(active);
      if (outcome.kind === "skip") {
        active.accumulatedDelay += FORFEIT_DELAY;
      }
      startTurn();
    };
    const enterAiming = () => {
      phase = "AIMING";
      clock.setTimeout(onTimeout, TURN_MS);
    };
    const startTurn = () => {
      phase = "TURN_START";
      activePlayer = advanceTurn(mobiles);
      clock.setTimeout(enterAiming, 10);
    };

    // Drive the first turn: 'a' (delay 0) is active.
    startTurn();
    expect(phase).toBe("TURN_START");
    expect(activePlayer).toBe("a");

    clock.advance(10); // TURN_START dwell → AIMING
    expect(phase).toBe("AIMING");

    clock.advance(TURN_MS); // turn timer fires → skip 'a', apply FORFEIT_DELAY
    // 'a' was skipped: its accumulatedDelay grew by FORFEIT_DELAY (0 → 50).
    expect(mobiles[0].accumulatedDelay).toBe(FORFEIT_DELAY);
    // The next turn advanced to 'b' (now the lowest delay: b=5 < a=50).
    expect(activePlayer).toBe("b");
  });
});
