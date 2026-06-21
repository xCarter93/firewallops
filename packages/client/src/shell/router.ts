import type PhaserNamespace from "phaser";
import {
  consumeReturnTo,
  isSignedIn,
  onAuthChange,
  requireAuth,
} from "./auth.js";

/** The router-owned Phaser game instance type (via the default-import namespace). */
type PhaserGame = PhaserNamespace.Game;
import { matchSession } from "./net/matchSession.js";
import { renderLanding } from "./pages/landing.js";
import { renderLobby } from "./pages/lobby.js";
import { renderRoom } from "./pages/room.js";

/**
 * Framework-free hash/history mini-router for the web-app shell (Phase 5, Plan 06).
 *
 * Routes (UI-SPEC web-shell recommendation):
 *   /            → landing (public gate)
 *   /lobby       → home hub + room list (plan 08)
 *   /room/:id    → lobby room / ready (plan 08)
 *   /play/:id    → Phaser match (plan 09)
 *
 * AUTH GATE (AUTH-01/02, LOBBY-05): every route EXCEPT `/` requires a Clerk
 * session. An unauthenticated navigation stashes the intended path
 * (`fwops:returnTo`) and opens sign-in; after a successful sign-in the auth
 * listener consumes the stash and navigates to the intended destination — so a
 * share-link survives the sign-in round-trip.
 *
 * PHASER LIFECYCLE OWNERSHIP (Pitfall 5): the router OWNS the Phaser game. Entering
 * `/play` creates `#game-container` under `#app` and instantiates `Phaser.Game`
 * (dynamically imported so Phaser is NEVER in the top-level bundle — it loads only
 * on /play); leaving `/play` calls `game.destroy(true)` and removes the container,
 * so a DOM page and a live canvas NEVER coexist.
 *
 * BLOCKER 3: the room→play transition reuses `matchSession.current` and does NOT
 * call `matchSession.leaveCurrent()`. Only navigating AWAY from the match flow
 * (RETURN TO LOBBY / a real quit) leaves the match. Plans 08/09 supply the lobby /
 * room / play page bodies; this router provides the routing + guard + Phaser
 * lifecycle skeleton they plug into.
 */

/** The play-route Phaser instance (null when not on /play). Router-owned. */
let activeGame: PhaserGame | null = null;

/**
 * The current DOM page's cleanup fn (lobby/room return one to tear down their
 * light LobbyRoom subscription / listeners on nav-away). Called before rendering
 * the next route so a page never leaks its subscription. NOTE: a page cleanup is
 * NOT a match leave — leaving the MatchRoom is matchSession's job (Blocker 3).
 */
let pageCleanup: (() => void) | null = null;

/** Run + clear the current page's cleanup fn (idempotent). */
function runPageCleanup(): void {
  if (pageCleanup) {
    pageCleanup();
    pageCleanup = null;
  }
}

/** The id the active Phaser match was mounted for (for the room→play reuse check). */
let activePlayRoomId: string | null = null;

/** The router mount root (`#app`). */
function appRoot(): HTMLElement {
  const root = document.getElementById("app");
  if (!root) throw new Error("router: #app mount root not found in index.html");
  return root;
}

/** Tear down the active Phaser game + remove `#game-container` (Pitfall 5). */
function teardownPlay(): void {
  if (activeGame) {
    activeGame.destroy(true);
    activeGame = null;
  }
  activePlayRoomId = null;
  document.getElementById("game-container")?.remove();
}

/**
 * Mount the Phaser match on `/play/:roomId` against the EXISTING `matchSession`
 * connection (Blocker 3 — does NOT re-join, does NOT leave the room→play
 * transition). Phaser is dynamically imported so it stays out of the top-level
 * bundle (LOBBY + AUTH delivery vehicle is canvas-free). The full play page +
 * overlays land in plan 09; this is the router's lifecycle hook.
 */
async function mountPlay(root: HTMLElement, roomId: string): Promise<void> {
  // Reuse the same Phaser instance if we are already playing this room.
  if (activeGame && activePlayRoomId === roomId) return;
  teardownPlay();

  root.innerHTML = "";
  const container = document.createElement("div");
  container.id = "game-container"; // GAME_CONFIG.parent === "game-container"
  container.style.width = "100vw";
  container.style.height = "100vh";
  root.appendChild(container);

  // matchSession.current is the single-owner MatchRoom the room page connected
  // (plan 08). If it is missing (e.g. a hard deep-link to /play), plan 09 will
  // reconnect / redirect; here we only own the canvas lifecycle.
  void matchSession.current;

  // Dynamic import keeps Phaser off the top-level chunk — instantiated ONLY here.
  const Phaser = (await import("phaser")).default;
  const { GAME_CONFIG } = await import("../game-config.js");
  activeGame = new Phaser.Game(GAME_CONFIG);
  activePlayRoomId = roomId;
}

/** A minimal placeholder page (plans 08/09 replace these bodies). */
function renderPlaceholder(root: HTMLElement, title: string, sub: string): void {
  root.innerHTML = "";
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    minHeight: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    background: "var(--bg)",
    color: "var(--text-2)",
    fontFamily: "var(--font-body)",
  } satisfies Partial<CSSStyleDeclaration>);
  const h = document.createElement("h1");
  h.textContent = title;
  h.style.fontFamily = "var(--font-display)";
  h.style.color = "var(--text)";
  const p = document.createElement("p");
  p.textContent = sub;
  p.style.color = "var(--muted)";
  wrap.append(h, p);
  root.appendChild(wrap);
}

/** Parse the current pathname into a route + params. */
interface Route {
  name: "landing" | "lobby" | "room" | "play" | "notfound";
  roomId?: string;
}

function parse(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { name: "landing" };
  if (pathname === "/lobby") return { name: "lobby" };
  const room = /^\/room\/([^/]+)$/.exec(pathname);
  if (room) return { name: "room", roomId: decodeURIComponent(room[1]) };
  const play = /^\/play\/([^/]+)$/.exec(pathname);
  if (play) return { name: "play", roomId: decodeURIComponent(play[1]) };
  return { name: "notfound" };
}

/** Render the route at the current `window.location.pathname`. */
async function render(): Promise<void> {
  const root = appRoot();
  const path = window.location.pathname;
  const route = parse(path);

  // Tear down the previous DOM page's subscription/listeners before rendering the
  // next route (lobby/room return a cleanup fn). This is NOT a match leave.
  runPageCleanup();

  // Auth gate — every route except the public landing requires a session. If not
  // signed in, requireAuth stashes the path + opens sign-in and we render the
  // landing as the backdrop; the auth listener re-navigates after sign-in.
  if (route.name !== "landing") {
    if (!requireAuth(path)) {
      renderLanding(root, navigate);
      return;
    }
  }

  // Leaving /play (to any non-play route) tears down Phaser (Pitfall 5). Note:
  // teardown does NOT leave the match — that is matchSession's job, invoked by the
  // page when the user truly quits / returns to lobby.
  if (route.name !== "play" && activeGame) {
    teardownPlay();
  }

  switch (route.name) {
    case "landing":
      renderLanding(root, navigate);
      return;
    case "lobby":
      // Home hub + live LobbyRoom room list (plan 08). Returns a cleanup fn that
      // closes the light LobbyRoom subscription on nav-away.
      pageCleanup = renderLobby(root, navigate);
      return;
    case "room":
      // Lobby room / ready screen (plan 08). Joins the MatchRoom via matchSession
      // (Blocker 3). Cleanup detaches listeners but does NOT leave the match (the
      // room→play transition reuses the connection).
      pageCleanup = renderRoom(root, route.roomId ?? "", navigate);
      return;
    case "play":
      await mountPlay(root, route.roomId ?? "");
      return;
    default:
      renderPlaceholder(root, "NOT FOUND", "That route does not exist.");
      return;
  }
}

/** Navigate to `path` (pushState + render). The shell's single nav entry point. */
export function navigate(path: string): void {
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
  }
  void render();
}

/**
 * Boot the router: wire `popstate` (back/forward), wire the Clerk auth listener
 * (so a modal sign-in consumes `fwops:returnTo` and navigates to the intended
 * destination), and render the initial route.
 */
export function startRouter(): void {
  window.addEventListener("popstate", () => {
    void render();
  });

  // After a successful (modal) sign-in, send the user to their intended
  // destination (the stashed share-link / route), or to /lobby by default.
  onAuthChange(() => {
    if (isSignedIn()) {
      const returnTo = consumeReturnTo();
      navigate(returnTo ?? "/lobby");
    } else {
      void render();
    }
  });

  void render();
}
