// @vitest-environment jsdom
//
// hudPreview.test.ts — the Wave-0 jsdom integration proof for the `?hudpreview`
// dev route (Phase 6, Plan 04). It proves the WHOLE point of the short-circuit:
// with `?hudpreview` on the URL, `render()` mounts the full DOM HUD overlay fed
// the static PREVIEW_VM fixture WITHOUT exercising the auth gate and WITHOUT any
// Colyseus join — the short-circuit returns BEFORE `requireAuth`.
//
// Everything heavy the router transitively imports is mocked so importing it does
// not pull real Clerk / Phaser / the WS client: auth (requireAuth is a spy so we
// can assert it is NOT called on this path), the lobby's LobbyRoom connection, the
// single-owner matchSession (its join/reconnect are spies we assert stay
// untouched), net/room, Phaser, and the play page's game-config. The overlay +
// hudPreviewData are the REAL modules (the thing under test).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Phaser + game-config: stubbed so the scene/view chain never loads ─────────
vi.mock("phaser", () => ({ default: { Game: vi.fn() } }));
vi.mock("../src/game-config.js", () => ({ GAME_CONFIG: { parent: "game-container" } }));

// ── auth: requireAuth is a SPY so we can assert the preview path never calls it ─
const requireAuthSpy = vi.fn(() => true);
vi.mock("../src/shell/auth.js", () => ({
  RETURN_TO_KEY: "fwops:returnTo",
  SERVER_HTTP_URL: "http://localhost:2567",
  isSignedIn: () => true,
  requireAuth: requireAuthSpy,
  openSignIn: vi.fn(),
  consumeReturnTo: () => null,
  onAuthChange: () => () => {},
  getToken: async () => "preview-token",
  mountUserButton: vi.fn(),
  initAuth: async () => {},
}));

// ── lobby's light LobbyRoom connection: an async no-op subscription ───────────
vi.mock("../src/shell/net/lobbyClient.js", () => ({
  subscribeLobby: vi.fn(async () => ({ close: vi.fn() })),
}));

// ── matchSession: join/reconnect are spies we assert the preview path never hits ─
const joinSpy = vi.fn(async () => null);
const reconnectSpy = vi.fn(async () => null);
const leaveCurrent = vi.fn(async () => {});
vi.mock("../src/shell/net/matchSession.js", () => ({
  matchSession: {
    get current() {
      return null;
    },
    get currentRoomId() {
      return null;
    },
    join: joinSpy,
    reconnect: reconnectSpy,
    leaveCurrent,
  },
}));

// ── net/room: the play-page Blocker-3 handoff (not exercised on the preview path) ─
vi.mock("../src/net/room.js", () => ({
  provideMatchRoom: vi.fn(),
  setShellMatchEndHook: vi.fn(),
  notifyShellMatchEnded: vi.fn(),
  takeProvidedMatchRoom: vi.fn(() => null),
  attachToMatch: vi.fn((r: unknown) => r),
}));

/** Wait a couple of microtasks/macrotasks so any async render settles. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("?hudpreview route", () => {
  beforeEach(() => {
    requireAuthSpy.mockClear();
    joinSpy.mockClear();
    reconnectSpy.mockClear();
    leaveCurrent.mockClear();
    document.body.innerHTML = '<div id="app"></div>';
    // The whole point: set the preview query param BEFORE starting the router.
    window.history.replaceState({}, "", "/?hudpreview=1");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("renders the full HUD with no auth/Colyseus when ?hudpreview is set", async () => {
    const { startRouter } = await import("../src/shell/router.js");
    startRouter();
    await flush();

    const app = document.getElementById("app");
    expect(app).not.toBeNull();
    const text = app?.textContent ?? "";

    // Action-bar weapon chips (every region populated).
    expect(text).toContain("PACKET");
    expect(text).toContain("FORKED");
    expect(text).toContain("TROJAN");
    // Chat empty-state.
    expect(text).toContain("COMMS CHANNEL OFFLINE");
    // Round em-dash sentinel (the overlay renders round:-1 as "RND —").
    expect(text).toContain("RND");
    expect(text).toContain("—");
    // CF-1 — the disconnected PREVIEW_VM row previews a non-numeric RECONNECTING…
    // state (concern 2: no fabricated countdown).
    expect(text).toContain("RECONNECTING");
    // Identity — the local row's YOU badge (concern 7).
    expect(text).toContain("YOU");
  });

  it("does NOT invoke the auth gate or any matchSession join on the preview path", async () => {
    const { startRouter } = await import("../src/shell/router.js");
    startRouter();
    await flush();

    // The short-circuit returns BEFORE requireAuth — the whole point of the route.
    expect(requireAuthSpy).not.toHaveBeenCalled();
    // No Colyseus join/reconnect happens — presentation only.
    expect(joinSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it("mounts the .fw-hud root as a pointer-events:none pass-through layer", async () => {
    const { startRouter } = await import("../src/shell/router.js");
    startRouter();
    await flush();

    const hudRoot = document.querySelector<HTMLElement>(".fw-hud");
    expect(hudRoot).not.toBeNull();
    expect(hudRoot?.style.pointerEvents).toBe("none");
  });

  it("shows the active line with the preview countdown (YOUR TURN + a 0: time)", async () => {
    const { startRouter } = await import("../src/shell/router.js");
    startRouter();
    await flush();

    const text = document.getElementById("app")?.textContent ?? "";
    expect(text).toContain("YOUR TURN");
    // formatCountdown(18000) → "0:18"; the active line concatenates the countdown.
    expect(text).toContain("0:");
  });
});
