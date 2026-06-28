// @vitest-environment jsdom
//
// shellSmoke.test.ts — the AUTOMATABLE slice of the otherwise-manual web-shell UI
// flow (Phase 5, Plan 09; review MEDIUM). It proves the canvas LIFECYCLE that the
// double-/blank-canvas regression (Blocker 3 / Pitfall 5) would break:
//
//   1. landing renders into #app (the BREACH THE FIREWALL headline exists);
//   2. /lobby renders the lobby WITHOUT creating a #game-container;
//   3. /play/:id creates EXACTLY ONE #game-container and instantiates Phaser.Game
//      EXACTLY once (no double canvas);
//   4. leaving /play calls Phaser destroy(true) and removes #game-container (no
//      blank-canvas leak).
//
// The WS + real Clerk + real Phaser scene paths exceed this smoke's scope and stay
// in the human-verify checkpoint (Task 3). Everything heavy is mocked: Clerk/auth,
// Phaser (a class spy with a destroy spy), the play page's game-config import (so
// the BootScene/MatchScene/view chain is NOT pulled in), the lobby's light
// LobbyRoom connection, and the single-owner matchSession (a fake current room so
// the Blocker-3 reuse path mounts WITHOUT a real join).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Phaser: a class spy whose instances carry a destroy spy ──────────────────
const destroySpy = vi.fn();
const gameCtor = vi.fn(function FakeGame(this: { destroy: typeof destroySpy }) {
  this.destroy = destroySpy;
});
vi.mock("phaser", () => ({
  default: { Game: gameCtor },
}));

// The play page dynamically imports the game-config; stub it so the scene/view
// chain (BootScene → MatchScene → Phaser views) is never loaded in the smoke.
vi.mock("../src/game-config.js", () => ({ GAME_CONFIG: { parent: "game-container" } }));

// ── auth: signed-in stub (no Clerk, no env key needed) ───────────────────────
let signedIn = true;
vi.mock("../src/shell/auth.js", () => ({
  RETURN_TO_KEY: "fwops:returnTo",
  // SERVER_HTTP_URL removed (plan 09-11, [A1]) — auth.ts no longer exports it; the
  // profile read/write moved to convexClient (mocked below).
  isSignedIn: () => signedIn,
  requireAuth: () => signedIn, // gate passes when signed in
  openSignIn: vi.fn(),
  consumeReturnTo: () => null,
  onAuthChange: () => () => {},
  getToken: async () => "smoke-token",
  mountUserButton: vi.fn(),
  initAuth: async () => {},
}));

// ── convexClient: profile read/write now runs on Convex (plan 09-11, [A1]) ───
// The lobby's loadProfile() calls convexClient.getMyProfile() on render (the old
// REST profile fetch is gone). Mock the module so the
// profile resolves WITHOUT a real ConvexClient (no VITE_CONVEX_URL / network).
// A populated display_name keeps the first-login handle prompt closed so the DOM
// assertions stay clean. getMyProfile reads `profileStub` so per-test cases can
// vary the W/L (the UI-04-partial assertion below). The room-create/join wrappers
// the lobby also imports are stubbed inert (they only fire on a user click).
let profileStub: { display_name: string; wins: number; losses: number } = {
  display_name: "SMOKE",
  wins: 0,
  losses: 0,
};
vi.mock("../src/net/convexClient.js", () => ({
  getMyProfile: vi.fn(async () => profileStub),
  setMyDisplayName: vi.fn(async () => {}),
  getLoadout: vi.fn(async () => ({ items: ["shot-1", "shot-2", "trojan"] })),
  createRoom: vi.fn(async () => "ROOM1"),
  joinMatch: vi.fn(async () => {}),
}));

// ── lobby's room-list subscription ───────────────────────────────────────────
// Plan 08: the lobby page now renders the room list from the REACTIVE Convex query
// via `subscribeLobbyConvex` (SYNCHRONOUS — returns a `LobbySubscription` with
// `.close()` directly, no join await). The legacy async Colyseus `subscribeLobby`
// is still exported (coexistence until plan 12) so we stub BOTH: the smoke only
// exercises subscribeLobbyConvex now, with an empty initial room list.
vi.mock("../src/shell/net/lobbyClient.js", () => ({
  subscribeLobby: vi.fn(async () => ({ close: vi.fn() })),
  subscribeLobbyConvex: vi.fn((onRooms: (rooms: unknown[]) => void) => {
    onRooms([]); // initial empty list — the lobby renders the empty state.
    return { close: vi.fn() };
  }),
}));

// ── matchSession: a fake single-owner room so /play reuses it (Blocker 3) ─────
const fakeRoom = {
  roomId: "ROOM1",
  sessionId: "sess-local",
  state: { mobiles: { forEach: () => {} } },
  onMessage: vi.fn(),
  onLeave: vi.fn(),
  onDrop: vi.fn(),
  onReconnect: vi.fn(),
  send: vi.fn(),
  leave: vi.fn(async () => {}),
};
const leaveCurrent = vi.fn(async () => {});
const convexLeaveCurrent = vi.fn(async () => {});
vi.mock("../src/shell/net/matchSession.js", () => ({
  matchSession: {
    get current() {
      return fakeRoom;
    },
    get currentRoomId() {
      return "ROOM1";
    },
    join: vi.fn(async () => fakeRoom),
    reconnect: vi.fn(async () => null),
    leaveCurrent,
  },
  // Convex single-owner session (plan 09-06/07/08). For this smoke `currentMatchId`
  // is null, so the play page's Convex gate (`currentMatchId === roomId`) is FALSE
  // and /play/ROOM1 takes the (still-active) Colyseus reuse path — exactly the
  // canvas-lifecycle invariant this smoke proves. Both the Convex TRAINING (plan 07)
  // and Convex MULTIPLAYER (plan 08) branches share that single gate and are covered
  // by the two-device human-verify gate, not this headless smoke.
  convexMatchSession: {
    get currentMatchId() {
      return null;
    },
    subscribe: vi.fn(),
    leaveCurrent: convexLeaveCurrent,
  },
}));

// ── net/room: capture provideMatchRoom (Blocker-3 handoff) ────────────────────
const provideMatchRoom = vi.fn();
vi.mock("../src/net/room.js", () => ({
  provideMatchRoom,
  setShellMatchEndHook: vi.fn(),
  setShellFireRejectedHook: vi.fn(),
  notifyShellMatchEnded: vi.fn(),
  notifyShellFireRejected: vi.fn(),
  takeProvidedMatchRoom: vi.fn(() => fakeRoom),
  attachToMatch: vi.fn((r: unknown) => r),
  disposeMatchHandlers: vi.fn(),
}));

/** Wait a tick so the play page's async dynamic-import mount resolves. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("shell smoke", () => {
  beforeEach(() => {
    signedIn = true;
    destroySpy.mockClear();
    gameCtor.mockClear();
    provideMatchRoom.mockClear();
    leaveCurrent.mockClear();
    // Plan 09-11 ([A1]): the lobby reads the profile via convexClient.getMyProfile()
    // (mocked above), NOT a REST fetch. Reset the profile stub to the default so a
    // populated display_name keeps the first-login handle prompt closed and the DOM
    // assertions stay clean. global.fetch is still stubbed as an inert guard so any
    // stray network call in jsdom fails closed rather than hitting the network.
    profileStub = { display_name: "SMOKE", wins: 0, losses: 0 };
    global.fetch = vi.fn(async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    document.body.innerHTML = '<div id="app"></div>';
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("renders landing → lobby (no canvas) → single play canvas → teardown", async () => {
    const { startRouter, navigate } = await import("../src/shell/router.js");

    // (1) landing renders into #app with the BREACH THE FIREWALL headline.
    startRouter();
    const app = document.getElementById("app");
    expect(app).not.toBeNull();
    expect(app?.textContent).toContain("BREACH");
    expect(app?.textContent).toContain("FIREWALL");
    expect(document.getElementById("game-container")).toBeNull();

    // (2) /lobby renders the lobby WITHOUT creating a #game-container.
    navigate("/lobby");
    await flush();
    expect(document.getElementById("game-container")).toBeNull();
    expect(gameCtor).not.toHaveBeenCalled();

    // (3) /play/:id creates EXACTLY ONE #game-container + ONE Phaser.Game.
    navigate("/play/ROOM1");
    await flush();
    expect(document.querySelectorAll("#game-container")).toHaveLength(1);
    expect(gameCtor).toHaveBeenCalledTimes(1); // no double canvas
    // Blocker 3: the play page handed the EXISTING room to the scene (no re-join).
    expect(provideMatchRoom).toHaveBeenCalledTimes(1);
    expect(provideMatchRoom).toHaveBeenCalledWith(fakeRoom);

    // (4) leaving /play destroys Phaser + removes the container (no blank-canvas).
    navigate("/lobby");
    await flush();
    expect(destroySpy).toHaveBeenCalledWith(true);
    expect(document.getElementById("game-container")).toBeNull();
    // The room→play→lobby nav did NOT leave the match on the swap; leaving the
    // match is matchSession's job only on a real quit / RETURN TO LOBBY.
    expect(leaveCurrent).not.toHaveBeenCalled();
  });

  // ── UI-04 partial (Meshed Home Hub): the restyled lobby surfaces the player's
  // REAL profile display name + W/L from the stubbed Convex getMyProfile read
  // (plan 09-11, [A1]). This is the Nyquist anchor proving the Meshed restyle +
  // the Convex repoint did not sever the profile data path (handleEl/wlEl ←
  // fetchProfile → loadProfile).
  it("Home Hub surfaces the profile display name + W/L from the stubbed Convex read (UI-04 partial)", async () => {
    // Vary the W/L from the beforeEach default so this asserts the LIVE wiring,
    // not a hardcoded "W 0 · L 0" — the values must reflect THIS stub. Plan 09-11
    // ([A1]): the profile now comes from convexClient.getMyProfile() (mocked above
    // via profileStub), NOT a REST fetch.
    profileStub = { display_name: "N1GHTW1RE", wins: 3, losses: 2 };

    const { startRouter, navigate } = await import("../src/shell/router.js");
    startRouter();

    navigate("/lobby");
    // loadProfile() resolves on a microtask after subscribeLobby; flush twice.
    await flush();
    await flush();

    const app = document.getElementById("app");
    expect(app).not.toBeNull();
    // REAL display name rendered (textContent path, never innerHTML).
    expect(app?.textContent).toContain("N1GHTW1RE");
    // REAL W/L line rendered from the SAME stub (proves it is live, not static).
    expect(app?.textContent).toContain("W 3");
    expect(app?.textContent).toContain("L 2");
    // The smoke invariant holds on the restyled Home Hub: no canvas is created.
    expect(document.getElementById("game-container")).toBeNull();
  });
});
