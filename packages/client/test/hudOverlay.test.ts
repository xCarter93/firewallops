// @vitest-environment jsdom
//
// hudOverlay.test.ts — the Wave-0 jsdom DOM-diff suite for the Phase-6 HUD render
// layer. It proves the two NEW live-data paths derived purely from view-model
// deltas (UI-03 channel 2 row pulse + CF-1 RECONNECTING state) plus the normalized
// public contract, the action-bar mirror, row reconciliation by id, region
// presence, the pointer-events:none root, and idempotent destroy — all without
// Phaser or Colyseus (the overlay imports only the view-model TYPES).

import { afterEach, describe, expect, it, vi } from "vitest";

import { mountHudOverlay } from "../src/shell/hud/hudOverlay.js";
import type {
  HudActionBar,
  HudTurnRow,
  HudViewModel,
  HudWeapon,
} from "../src/shell/hud/hudViewModel.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function weapon(id: string, over: Partial<HudWeapon> = {}): HudWeapon {
  return { id, label: id.toUpperCase(), selected: false, locked: false, ...over };
}

function actionBar(over: Partial<HudActionBar> = {}): HudActionBar {
  return {
    weapons: [weapon("packet"), weapon("forked"), weapon("trojan", { chargeLabel: "0/3" })],
    power: 0,
    angleDeg: 0,
    selectedItemId: "",
    ssHitCharge: 0,
    powerLocked: false,
    moveBudget: -1,
    hasLocalMobile: true,
    ...over,
  };
}

function row(id: string, over: Partial<HudTurnRow> = {}): HudTurnRow {
  return {
    id,
    label: id.toUpperCase(),
    isLocal: false,
    hp: 100,
    isActive: false,
    eliminated: false,
    connected: true,
    team: 0,
    ...over,
  };
}

function vmFixture(over: Partial<HudViewModel> = {}): HudViewModel {
  return {
    round: -1,
    phase: "AIMING",
    activeLabel: "",
    activeIsLocal: false,
    localPlayerId: "me",
    turnRows: [],
    wind: 0,
    blips: [],
    actionBar: actionBar(),
    winnerTeam: -1,
    matchOver: false,
    ...over,
  };
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handle = mountHudOverlay(container);
  return { container, handle };
}

function rowEl(container: HTMLElement, id: string): HTMLElement | null {
  // Rows are reconciled by id; find by label textContent within a .fw-hud-row.
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".fw-hud-row"));
  return rows.find((r) => r.querySelector(".fw-hud-row-label")?.textContent === id.toUpperCase()) ?? null;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("hudOverlay — region presence + contract", () => {
  it("renders all regions, empty-states, and a pointer-events:none root", () => {
    const { container, handle } = mount();
    handle.update(vmFixture());

    const root = container.querySelector<HTMLElement>(".fw-hud");
    expect(root).not.toBeNull();
    expect(root?.style.pointerEvents).toBe("none");

    expect(container.textContent).toContain("COMMS CHANNEL OFFLINE");
    expect(container.textContent).toContain("PACKET");
    expect(container.textContent).toContain("FORKED");
    expect(container.textContent).toContain("TROJAN");

    handle.destroy();
  });
});

describe("hudOverlay — UI-02 active row + countdown (concern 6 signature)", () => {
  it("renders the active marker and the two-arg countdown line", () => {
    const { container, handle } = mount();
    handle.update(
      vmFixture({
        activeLabel: "YOUR TURN",
        activeIsLocal: true,
        turnRows: [row("a", { isActive: true })],
      }),
      "0:18",
    );

    const a = rowEl(container, "a");
    expect(a?.textContent).toContain("▸");

    const countdown = container.querySelector(".fw-hud-countdown");
    expect(countdown?.textContent).toContain("YOUR TURN");
    expect(countdown?.textContent).toContain("0:18");

    handle.destroy();
  });
});

describe("hudOverlay — UI-03 HP-tick pulse (phase-gated, concern 5)", () => {
  it("pulses on hp decrease while RESOLVING and updates the HP number", () => {
    vi.useFakeTimers();
    const { container, handle } = mount();
    handle.update(vmFixture({ phase: "RESOLVING", turnRows: [row("a", { hp: 80 })] }));
    handle.update(vmFixture({ phase: "RESOLVING", turnRows: [row("a", { hp: 50 })] }));

    const a = rowEl(container, "a");
    expect(a?.classList.contains("fw-hud-row--hit")).toBe(true);
    expect(a?.querySelector(".fw-hud-row-hp")?.textContent).toBe("50");

    handle.destroy();
  });

  it("does NOT pulse on hp decrease while AIMING (pre-impact) but still updates HP", () => {
    const { container, handle } = mount();
    handle.update(vmFixture({ phase: "AIMING", turnRows: [row("a", { hp: 80 })] }));
    handle.update(vmFixture({ phase: "AIMING", turnRows: [row("a", { hp: 50 })] }));

    const a = rowEl(container, "a");
    expect(a?.classList.contains("fw-hud-row--hit")).toBe(false);
    expect(a?.querySelector(".fw-hud-row-hp")?.textContent).toBe("50");

    handle.destroy();
  });

  it("does NOT pulse when hp does not decrease, even while RESOLVING", () => {
    const { container, handle } = mount();
    handle.update(vmFixture({ phase: "RESOLVING", turnRows: [row("a", { hp: 80 })] }));
    handle.update(vmFixture({ phase: "RESOLVING", turnRows: [row("a", { hp: 80 })] }));
    expect(rowEl(container, "a")?.classList.contains("fw-hud-row--hit")).toBe(false);

    handle.update(vmFixture({ phase: "RESOLVING", turnRows: [row("a", { hp: 90 })] }));
    expect(rowEl(container, "a")?.classList.contains("fw-hud-row--hit")).toBe(false);

    handle.destroy();
  });
});

describe("hudOverlay — CF-1 RECONNECTING (non-numeric, concern 2)", () => {
  it("renders a non-numeric RECONNECTING state with no countdown for a disconnected row", () => {
    const { container, handle } = mount();
    handle.update(vmFixture({ turnRows: [row("a", { connected: false })] }));

    const a = rowEl(container, "a");
    const tag = a?.querySelector<HTMLElement>(".fw-hud-row-reconnecting");
    expect(tag).not.toBeNull();
    expect(tag?.style.display).not.toBe("none");
    expect(a?.textContent).toContain("RECONNECTING");
    // No fabricated numeric seconds countdown on the row.
    expect(a?.textContent ?? "").not.toMatch(/0:\d/);

    handle.destroy();
  });

  it("clears the RECONNECTING state when the row reconnects", () => {
    const { container, handle } = mount();
    handle.update(vmFixture({ turnRows: [row("a", { connected: false })] }));
    handle.update(vmFixture({ turnRows: [row("a", { connected: true })] }));

    const tag = rowEl(container, "a")?.querySelector<HTMLElement>(".fw-hud-row-reconnecting");
    expect(tag?.style.display).toBe("none");

    handle.destroy();
  });
});

describe("hudOverlay — concern 7 YOU badge", () => {
  it("shows YOU only on the local row", () => {
    const { container, handle } = mount();
    handle.update(
      vmFixture({ turnRows: [row("me", { isLocal: true }), row("them", { isLocal: false })] }),
    );

    const me = rowEl(container, "me")?.querySelector<HTMLElement>(".fw-hud-row-you");
    const them = rowEl(container, "them")?.querySelector<HTMLElement>(".fw-hud-row-you");
    expect(me?.style.display).not.toBe("none");
    expect(me?.textContent).toBe("YOU");
    expect(them?.style.display).toBe("none");

    handle.destroy();
  });
});

describe("hudOverlay — concern 1 action-bar live mirror", () => {
  it("renders power, selected chip, trojan 2/3 lock, and MOVE dash", () => {
    const { container, handle } = mount();
    handle.update(
      vmFixture({
        actionBar: actionBar({
          power: 50,
          selectedItemId: "shot-1",
          moveBudget: -1,
          weapons: [
            weapon("packet", { selected: true }),
            weapon("forked"),
            weapon("trojan", { locked: true, chargeLabel: "2/3" }),
          ],
        }),
      }),
    );

    expect(container.querySelector(".fw-hud-power-pct")?.textContent).toBe("50%");
    expect(container.querySelector<HTMLElement>(".fw-hud-power-fill")?.style.width).toBe("50%");

    const packet = Array.from(container.querySelectorAll<HTMLElement>(".fw-hud-chip")).find(
      (c) => c.querySelector(".fw-hud-chip-label")?.textContent === "PACKET",
    );
    // Selected chip gets the cyan glow box-shadow (a plain string jsdom always stores).
    expect(packet?.style.boxShadow).not.toBe("none");
    expect(packet?.style.boxShadow.length).toBeGreaterThan(0);

    const trojanCharge = container.querySelector(".fw-hud-trojan-charge");
    expect(trojanCharge?.textContent).toContain("2/3");

    expect(container.querySelector(".fw-hud-move-val")?.textContent).toBe("—");

    handle.destroy();
  });
});

describe("hudOverlay — row reconciliation by id", () => {
  it("preserves element identity across reorder and removes dropped rows", () => {
    const { container, handle } = mount();
    handle.update(vmFixture({ turnRows: [row("a"), row("b")] }));
    const aFirst = rowEl(container, "a");
    const bFirst = rowEl(container, "b");

    handle.update(vmFixture({ turnRows: [row("b"), row("a")] }));
    expect(rowEl(container, "a")).toBe(aFirst); // same element instance
    expect(rowEl(container, "b")).toBe(bFirst);

    // DOM order now b, a.
    const rows = Array.from(container.querySelectorAll(".fw-hud-row"));
    expect(rows[0]).toBe(bFirst);
    expect(rows[1]).toBe(aFirst);

    handle.update(vmFixture({ turnRows: [row("a")] }));
    expect(rowEl(container, "a")).toBe(aFirst);
    expect(rowEl(container, "b")).toBeNull();

    handle.destroy();
  });
});

describe("hudOverlay — destroy()", () => {
  it("removes the root, is idempotent, and clears pending pulse timers", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { container, handle } = mount();

    // Trigger a pulse so there is a pending timer.
    handle.update(vmFixture({ phase: "RESOLVING", turnRows: [row("a", { hp: 80 })] }));
    handle.update(vmFixture({ phase: "RESOLVING", turnRows: [row("a", { hp: 50 })] }));

    handle.destroy();
    expect(container.querySelector(".fw-hud")).toBeNull();
    expect(clearSpy).toHaveBeenCalled();

    expect(() => handle.destroy()).not.toThrow(); // idempotent

    clearSpy.mockRestore();
  });
});
