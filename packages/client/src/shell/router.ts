import {
  consumeReturnTo,
  isSignedIn,
  onAuthChange,
  requireAuth,
} from "./auth.js";
import { renderLanding } from "./pages/landing.js";
import { renderLobby } from "./pages/lobby.js";
import { renderRoom } from "./pages/room.js";
import { renderPlay } from "./pages/play.js";

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
 * PHASER LIFECYCLE OWNERSHIP (Pitfall 5): the router owns WHEN the Phaser surface
 * mounts/unmounts; the play page (plan 09, `renderPlay`) owns HOW — it creates
 * `#game-container` + the single `Phaser.Game` (dynamically imported so Phaser is
 * NEVER in the top-level bundle — it loads only on /play) and returns a cleanup
 * fn. The router runs that cleanup (which `game.destroy(true)`-es + removes the
 * container) before rendering any next route, so a DOM page and a live canvas
 * NEVER coexist.
 *
 * BLOCKER 3: the room→play transition reuses `matchSession.current` and does NOT
 * call `matchSession.leaveCurrent()`. Only navigating AWAY from the match flow
 * (RETURN TO LOBBY / a real quit) leaves the match. The play page enforces this;
 * the router only routes + guards + runs the page cleanup.
 */

/**
 * The current page's cleanup fn (lobby/room/play return one). Lobby/room tear down
 * their light LobbyRoom subscription / listeners; the play page tears down Phaser +
 * `#game-container` + its overlays. Called before rendering the next route so a
 * page never leaks. NOTE: a page cleanup is NOT a match leave — leaving the
 * MatchRoom is matchSession's job (Blocker 3), invoked by the play page only on a
 * real quit / RETURN TO LOBBY.
 */
let pageCleanup: (() => void) | null = null;

/** Run + clear the current page's cleanup fn (idempotent). */
function runPageCleanup(): void {
  if (pageCleanup) {
    pageCleanup();
    pageCleanup = null;
  }
}

/** The router mount root (`#app`). */
function appRoot(): HTMLElement {
  const root = document.getElementById("app");
  if (!root) throw new Error("router: #app mount root not found in index.html");
  return root;
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
function render(): void {
  const root = appRoot();
  const path = window.location.pathname;
  const route = parse(path);

  // Tear down the previous page (lobby/room subscription, OR the play page's Phaser
  // canvas + overlays) before rendering the next route. This is NOT a match leave —
  // leaving the MatchRoom is matchSession's job (Blocker 3), invoked by the play
  // page only on a real quit / RETURN TO LOBBY.
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
      // Phaser match (plan 09). Mounts the single canvas against
      // matchSession.current (Blocker 3 — no re-join, no leave on the room→play
      // swap). Cleanup destroys Phaser + the container + overlays (Pitfall 5).
      pageCleanup = renderPlay(root, route.roomId ?? "", navigate);
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
  render();
}

/**
 * Boot the router: wire `popstate` (back/forward), wire the Clerk auth listener
 * (so a modal sign-in consumes `fwops:returnTo` and navigates to the intended
 * destination), and render the initial route.
 */
export function startRouter(): void {
  window.addEventListener("popstate", () => {
    render();
  });

  // After a successful (modal) sign-in, send the user to their intended
  // destination (the stashed share-link / route), or to /lobby by default.
  onAuthChange(() => {
    if (isSignedIn()) {
      const returnTo = consumeReturnTo();
      navigate(returnTo ?? "/lobby");
    } else {
      render();
    }
  });

  render();
}
