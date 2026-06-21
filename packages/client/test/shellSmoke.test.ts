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
  SERVER_HTTP_URL: "http://localhost:2567",
  isSignedIn: () => signedIn,
  requireAuth: () => signedIn, // gate passes when signed in
  openSignIn: vi.fn(),
  consumeReturnTo: () => null,
  onAuthChange: () => () => {},
  getToken: async () => "smoke-token",
  mountUserButton: vi.fn(),
  initAuth: async () => {},
}));

// ── lobby's light LobbyRoom connection: an async no-op subscription ───────────
// `subscribeLobby` is async and resolves to a `LobbySubscription` with `.close()`.
vi.mock("../src/shell/net/lobbyClient.js", () => ({
  subscribeLobby: vi.fn(async () => ({ close: vi.fn() })),
}));

// ── matchSession: a fake single-owner room so /play reuses it (Blocker 3) ─────
const fakeRoom = {
  roomId: "ROOM1",
  sessionId: "sess-local",
  state: { mobiles: { forEach: () => {} } },
  onMessage: vi.fn(),
  onLeave: vi.fn(),
  leave: vi.fn(async () => {}),
};
const leaveCurrent = vi.fn(async () => {});
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
}));

// ── net/room: capture provideMatchRoom (Blocker-3 handoff) ────────────────────
const provideMatchRoom = vi.fn();
vi.mock("../src/net/room.js", () => ({
  provideMatchRoom,
  setShellMatchEndHook: vi.fn(),
  notifyShellMatchEnded: vi.fn(),
  takeProvidedMatchRoom: vi.fn(() => fakeRoom),
  attachToMatch: vi.fn((r: unknown) => r),
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
    // The lobby reads the profile over REST; stub fetch so jsdom has no real
    // network. A populated display_name keeps the first-login handle prompt closed
    // so the DOM assertions stay clean.
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ display_name: "SMOKE", wins: 0, losses: 0 }), {
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
});
