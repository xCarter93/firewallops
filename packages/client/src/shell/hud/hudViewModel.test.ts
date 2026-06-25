// Pure node Vitest suite for the HUD view-model reducer + countdown helpers.
// NO `// @vitest-environment jsdom` pragma — this exercises ONLY the pure reducer
// (no DOM, no Phaser, no live room). Wave 0 deliverable (06-VALIDATION.md):
// UI-02 active/order/label, UI-03 hp/eliminated, CF-1 connected, the live
// action-bar mirror + moveBudget sentinel, the empty-state guard, minimap xFrac,
// the round sentinel, and both countdown helpers.

import { describe, expect, it } from "vitest";

import {
  EMPTY_VM,
  buildViewModel,
  formatCountdown,
  shouldShowCountdown,
  type SyncedLike,
  type SyncedMobileLike,
} from "./hudViewModel.js";

// ── fake-state factory ───────────────────────────────────────────────────────
// A plain object mirroring the Colyseus MapSchema `forEach(cb)` + `size` surface
// over an array of plain mobiles. Every SyncedMobileLike field gets a sensible
// default so each test varies only what it asserts.

function mob(overrides: Partial<SyncedMobileLike> & { sessionId: string }): SyncedMobileLike {
  return {
    team: 0,
    x: 0,
    y: 0,
    hp: 100,
    angleDeg: 45,
    power: 0,
    powerLocked: false,
    facing: 1,
    ssHitCharge: 0,
    accumulatedDelay: 0,
    selectedItemId: "shot-1",
    displayName: "",
    connected: true,
    ...overrides,
  };
}

function makeState(
  mobiles: SyncedMobileLike[],
  overrides: Partial<Omit<SyncedLike, "mobiles">> = {},
): SyncedLike {
  return {
    phase: "AIMING",
    activePlayer: "",
    wind: 0,
    turnEndsAt: 0,
    winnerTeam: -1,
    mobiles: {
      size: mobiles.length,
      forEach(cb: (m: SyncedMobileLike, key: string) => void): void {
        mobiles.forEach((m) => cb(m, m.sessionId));
      },
    },
    ...overrides,
  };
}

describe("buildViewModel — UI-02 turn list", () => {
  it("marks exactly the activePlayer row isActive", () => {
    const state = makeState([mob({ sessionId: "p1" }), mob({ sessionId: "p2" })], {
      activePlayer: "p2",
    });
    const vm = buildViewModel(state, "p1");
    expect(vm.turnRows.find((r) => r.id === "p2")?.isActive).toBe(true);
    expect(vm.turnRows.filter((r) => r.isActive)).toHaveLength(1);
  });

  it("orders rows by ascending accumulatedDelay", () => {
    const state = makeState([
      mob({ sessionId: "a", accumulatedDelay: 30 }),
      mob({ sessionId: "b", accumulatedDelay: 10 }),
      mob({ sessionId: "c", accumulatedDelay: 20 }),
    ]);
    const vm = buildViewModel(state, "a");
    expect(vm.turnRows.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("derives activeLabel + activeIsLocal from whose turn it is", () => {
    const local = makeState([mob({ sessionId: "me" }), mob({ sessionId: "you", displayName: "NEO" })], {
      activePlayer: "me",
    });
    const vmLocal = buildViewModel(local, "me");
    expect(vmLocal.activeLabel).toBe("YOUR TURN");
    expect(vmLocal.activeIsLocal).toBe(true);

    const other = makeState([mob({ sessionId: "me" }), mob({ sessionId: "you", displayName: "NEO" })], {
      activePlayer: "you",
    });
    const vmOther = buildViewModel(other, "me");
    expect(vmOther.activeLabel.endsWith("'S TURN")).toBe(true);
    expect(vmOther.activeIsLocal).toBe(false);
  });
});

describe("buildViewModel — UI-03 hp / eliminated", () => {
  it("carries the synced hp onto the row", () => {
    const state = makeState([mob({ sessionId: "p1", hp: 73 })]);
    const vm = buildViewModel(state, "p1");
    expect(vm.turnRows.find((r) => r.id === "p1")?.hp).toBe(73);
  });

  it("flags eliminated when hp <= 0 and not when hp > 0", () => {
    const state = makeState([
      mob({ sessionId: "dead0", hp: 0 }),
      mob({ sessionId: "deadNeg", hp: -5 }),
      mob({ sessionId: "alive", hp: 1 }),
    ]);
    const vm = buildViewModel(state, "alive");
    expect(vm.turnRows.find((r) => r.id === "dead0")?.eliminated).toBe(true);
    expect(vm.turnRows.find((r) => r.id === "deadNeg")?.eliminated).toBe(true);
    expect(vm.turnRows.find((r) => r.id === "alive")?.eliminated).toBe(false);
  });
});

describe("buildViewModel — CF-1 connected", () => {
  it("reflects connected:false/true and defaults missing to connected", () => {
    const state = makeState([
      mob({ sessionId: "down", connected: false }),
      mob({ sessionId: "up", connected: true }),
      mob({ sessionId: "unset", connected: undefined }),
    ]);
    const vm = buildViewModel(state, "up");
    expect(vm.turnRows.find((r) => r.id === "down")?.connected).toBe(false);
    expect(vm.turnRows.find((r) => r.id === "up")?.connected).toBe(true);
    expect(vm.turnRows.find((r) => r.id === "unset")?.connected).toBe(true);
  });
});

describe("buildViewModel — empty-state guard", () => {
  it("returns EMPTY_VM (no throw) when mobiles is undefined", () => {
    const state: SyncedLike = {
      phase: "AIMING",
      activePlayer: "p1",
      wind: 5,
      turnEndsAt: 0,
      winnerTeam: -1,
      mobiles: undefined,
    };
    let vm!: ReturnType<typeof buildViewModel>;
    expect(() => {
      vm = buildViewModel(state, "p1");
    }).not.toThrow();
    expect(vm).toBe(EMPTY_VM);
    expect(vm.turnRows).toHaveLength(0);
    expect(vm.round).toBe(-1);
    expect(vm.actionBar.hasLocalMobile).toBe(false);
  });
});

describe("buildViewModel — minimap blips", () => {
  it("normalizes xFrac = x / MAP_WIDTH and clamps to [0,1]", () => {
    const state = makeState([
      mob({ sessionId: "mid", x: 1024 }),
      mob({ sessionId: "left", x: 0 }),
      mob({ sessionId: "over", x: 4096 }),
    ]);
    const vm = buildViewModel(state, "mid");
    expect(vm.blips.find((b) => b.id === "mid")?.xFrac).toBe(0.5);
    expect(vm.blips.find((b) => b.id === "left")?.xFrac).toBe(0);
    expect(vm.blips.find((b) => b.id === "over")?.xFrac).toBe(1);
  });
});

describe("buildViewModel — round sentinel", () => {
  it("uses -1 (the em-dash sentinel) since MatchState has no round field", () => {
    const state = makeState([mob({ sessionId: "p1" })]);
    expect(buildViewModel(state, "p1").round).toBe(-1);
  });
});

describe("buildViewModel — concern 7 row identity", () => {
  it("labels the local row YOU, others by displayName, with the TEAM fallback", () => {
    const state = makeState([
      mob({ sessionId: "me" }),
      mob({ sessionId: "neo", displayName: "NEO", team: 1 }),
      mob({ sessionId: "anonA", displayName: "", team: 0 }),
      mob({ sessionId: "anonB", displayName: "   ", team: 1 }),
    ]);
    const vm = buildViewModel(state, "me");
    const meRow = vm.turnRows.find((r) => r.id === "me");
    expect(meRow?.isLocal).toBe(true);
    expect(meRow?.label).toBe("YOU");

    const neoRow = vm.turnRows.find((r) => r.id === "neo");
    expect(neoRow?.isLocal).toBe(false);
    expect(neoRow?.label).toBe("NEO");

    expect(vm.turnRows.find((r) => r.id === "anonA")?.label).toBe("TEAM A");
    expect(vm.turnRows.find((r) => r.id === "anonB")?.label).toBe("TEAM B");
  });
});

describe("buildViewModel — concern 1 action-bar live mirror", () => {
  it("mirrors the LOCAL mobile's action state + trojan charge transition", () => {
    const below = makeState([
      mob({
        sessionId: "me",
        power: 0.7,
        angleDeg: 42,
        selectedItemId: "shot-2",
        ssHitCharge: 2,
        powerLocked: true,
      }),
    ]);
    const vm = buildViewModel(below, "me");
    expect(vm.actionBar.power).toBe(0.7);
    expect(vm.actionBar.angleDeg).toBe(42);
    expect(vm.actionBar.selectedItemId).toBe("shot-2");
    expect(vm.actionBar.ssHitCharge).toBe(2);
    expect(vm.actionBar.powerLocked).toBe(true);
    expect(vm.actionBar.hasLocalMobile).toBe(true);

    const trojan = vm.actionBar.weapons.find((w) => w.id === "trojan");
    expect(trojan?.locked).toBe(true);
    expect(trojan?.chargeLabel).toBe("2/3");

    const armed = buildViewModel(
      makeState([mob({ sessionId: "me", ssHitCharge: 3 })]),
      "me",
    );
    const armedTrojan = armed.actionBar.weapons.find((w) => w.id === "trojan");
    expect(armedTrojan?.locked).toBe(false);
    expect(armedTrojan?.chargeLabel).toBe("3/3");
  });

  it("surfaces moveBudget as the -1 sentinel regardless of mobile fields", () => {
    const vm = buildViewModel(
      makeState([mob({ sessionId: "me", power: 0.9, ssHitCharge: 3 })]),
      "me",
    );
    expect(vm.actionBar.moveBudget).toBe(-1);
  });

  it("renders neutral chrome (no local mobile) without throwing", () => {
    const state = makeState([mob({ sessionId: "p1", selectedItemId: "shot-2" })]);
    let vm!: ReturnType<typeof buildViewModel>;
    expect(() => {
      vm = buildViewModel(state, "spectator");
    }).not.toThrow();
    expect(vm.actionBar.hasLocalMobile).toBe(false);
    expect(vm.actionBar.weapons.every((w) => !w.selected)).toBe(true);
    expect(vm.actionBar.weapons.every((w) => !w.locked)).toBe(true);
  });
});

describe("formatCountdown", () => {
  it("formats ms-remaining as M:SS with SS zero-padded", () => {
    expect(formatCountdown(18000)).toBe("0:18");
    expect(formatCountdown(65000)).toBe("1:05");
    expect(formatCountdown(-500)).toBe("0:00");
    expect(formatCountdown(5000)).toBe("0:05");
  });
});

describe("shouldShowCountdown", () => {
  it("is true only in the AIMING phase with a positive deadline", () => {
    expect(shouldShowCountdown("AIMING", 20_000)).toBe(true);
    expect(shouldShowCountdown("RESOLVING", 20_000)).toBe(false);
    expect(shouldShowCountdown("WAITING", 20_000)).toBe(false);
  });
  it("is false in training (turnEndsAt === 0) even while AIMING", () => {
    // Training disables the turn timer (turnEndsAt === 0) → no countdown.
    expect(shouldShowCountdown("AIMING", 0)).toBe(false);
  });
});
