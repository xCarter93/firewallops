import { Clerk } from "@clerk/clerk-js";

/**
 * Clerk vanilla (non-React) auth module for the web-app shell (Phase 5, Plan 06).
 *
 * This is the single seam the shell uses to (a) gate the app on a Clerk session,
 * (b) read the session TOKEN that is passed to Colyseus join options (browsers
 * cannot set WS headers — AUTH-03), and (c) render the Clerk prebuilt sign-in /
 * user-button UI themed to the Firewallops SOC palette.
 *
 * SPIKE OUTCOME (research Pitfall 6 — clerk-js v6 vanilla prebuilt init):
 * The shipped `@clerk/clerk-js` 6.20.0 line lazy-loads its prebuilt UI bundle
 * internally when a `mount*`/`open*` method is first called — the v6 quickstart's
 * `load({ ui: { ClerkUI: ... } })` ctor-injection (research Pitfall 6 warning) was
 * a PRE-RELEASE artifact and is NOT required by the shipped 6.x package. The
 * confirmed vanilla surface this module codes against (verify at build time):
 *   import { Clerk } from "@clerk/clerk-js"           // the Clerk class
 *   const clerk = new Clerk(publishableKey)           // ctor takes the pk_... key
 *   await clerk.load({ appearance })                  // appearance themes the UI
 *   clerk.isSignedIn: boolean                         // sync signed-in flag
 *   clerk.session?.getToken(): Promise<string|null>   // the session JWT (AUTH-03)
 *   clerk.openSignIn(props?) / clerk.mountSignIn(node, props?)
 *   clerk.mountUserButton(node, props?)
 *   clerk.signOut(): Promise<void>
 * `appearance.variables` themes the prebuilt components to the UI-SPEC palette.
 *
 * REST base (review MEDIUM): `SERVER_HTTP_URL` resolves the DISTINCT HTTPS base
 * for the Meta-API (`/internal/profile`), separate from the `wss://` game-server
 * URL in net/room.ts. Profile reads/writes (plan 07+) attach the Clerk token as a
 * Bearer header to this base.
 */

/**
 * The HTTPS base for the REST Meta-API (`/internal/profile`). DISTINCT from
 * `VITE_SERVER_URL` (the `wss://` WS URL the Colyseus `Client` uses): the Meta-API
 * is plain HTTPS, the game server is WS. A PRODUCTION build with a missing/empty
 * `VITE_SERVER_HTTP_URL` throws loudly (mirroring `resolveServerUrl` in net/room.ts
 * — no silent localhost in prod); DEV falls back to `http://localhost:2567`.
 */
function resolveServerHttpUrl(): string {
  const envUrl = import.meta.env.VITE_SERVER_HTTP_URL;
  if (import.meta.env.PROD && (envUrl === undefined || envUrl.trim() === "")) {
    throw new Error(
      "VITE_SERVER_HTTP_URL is required for a production build (the deployed " +
        "https:// Meta-API base for /internal/profile). It is DISTINCT from " +
        "VITE_SERVER_URL (the wss:// WS URL). Refusing to fall back to " +
        "http://localhost:2567 in production. Set VITE_SERVER_HTTP_URL in the " +
        "Vercel build env.",
    );
  }
  return envUrl ?? "http://localhost:2567";
}

/** The distinct REST base for the Meta-API (`/internal/profile`). */
export const SERVER_HTTP_URL = resolveServerHttpUrl();

/**
 * sessionStorage key holding the intended destination an unauthenticated visitor
 * was trying to reach (a share-link / deep route). The router stashes it before
 * opening sign-in and reads it back AFTER a successful sign-in so a share-link
 * survives the auth round-trip (AUTH-01/02, LOBBY-05). Tab-scoped (sessionStorage).
 */
export const RETURN_TO_KEY = "fwops:returnTo";

/**
 * Clerk prebuilt-component theming to the UI-SPEC SOC palette. Applied via the
 * `appearance` option on `load()` (and re-passable to mount props). Card surface
 * `#141E33` on the `#0F172A` field, primary cyan `#22D3EE` with `#06141F` text,
 * inputs `#0B1220`, body text `#CBD5E1`, hairline borders, Fira Code / Orbitron.
 * Untyped here on purpose: clerk-js 6.x bundles its appearance types inline and
 * has no `@clerk/types` dependency to import from, so this object is validated
 * structurally at each `load()`/`mount*()` call site against clerk-js's own param
 * types (the documented, stable `variables` subset).
 */
const appearance = {
  variables: {
    colorBackground: "#141E33",
    colorPrimary: "#22D3EE",
    colorText: "#F8FAFC",
    colorTextSecondary: "#CBD5E1",
    colorInputBackground: "#0B1220",
    colorInputText: "#F8FAFC",
    colorDanger: "#EF4444",
    colorSuccess: "#22C55E",
    colorWarning: "#F59E0B",
    fontFamily: "'Fira Code', monospace",
    borderRadius: "3px",
  },
};

/**
 * The Clerk singleton. `null` until `initAuth()` resolves. Every exported helper
 * reads through `requireClerk()` so a call before init throws a clear error rather
 * than a silent `undefined`.
 */
let clerk: Clerk | null = null;

function requireClerk(): Clerk {
  if (!clerk) {
    throw new Error(
      "auth not initialized — call initAuth() (in main.ts) before any auth helper.",
    );
  }
  return clerk;
}

/**
 * Initialize Clerk once at boot. Reads `VITE_CLERK_PUBLISHABLE_KEY` (Vite inlines
 * it at build time), constructs the `Clerk` singleton, and `load()`s it with the
 * palette `appearance`. A missing publishable key throws loudly (the shell cannot
 * gate without auth). Idempotent — a second call is a no-op.
 */
export async function initAuth(): Promise<void> {
  if (clerk) return;
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!key || key.trim() === "") {
    throw new Error(
      "VITE_CLERK_PUBLISHABLE_KEY is required — the web-app shell gates every " +
        "route on a Clerk session and cannot boot without it. Set it in the " +
        "client .env (DEV) and in Vercel (deploy): Clerk Dashboard → API keys → " +
        "Publishable key (pk_...).",
    );
  }
  const instance = new Clerk(key);
  await instance.load({ appearance });
  clerk = instance;
}

/** True if a Clerk session is active (sync). */
export function isSignedIn(): boolean {
  return requireClerk().isSignedIn === true;
}

/**
 * The Clerk session JWT, or `null` if signed out / no session. This is the token
 * passed to Colyseus join options (AUTH-03) and as a `Bearer` header to the
 * Meta-API. `clerk.session?.getToken()` mints/returns the short-lived session
 * token; the caller fetches it fresh per join (it can expire).
 */
export async function getToken(): Promise<string | null> {
  const c = requireClerk();
  return (await c.session?.getToken()) ?? null;
}

/**
 * Mount the Clerk prebuilt sign-in component into `node` (themed). Used by the
 * router's auth surface. `node` is an `HTMLDivElement` (clerk-js v6 `mountSignIn`
 * requires a div). Redirect props are intentionally omitted — the router's auth
 * listener (see `onAuthChange`) drives post-sign-in navigation via the stashed
 * `fwops:returnTo`, so Clerk does not perform its own redirect.
 */
export function mountSignIn(node: HTMLDivElement): void {
  requireClerk().mountSignIn(node, { appearance });
}

/**
 * Open the Clerk prebuilt sign-in MODAL (themed). Used by the landing CTAs and
 * the auth guard. On success the registered auth listener (see `onAuthChange`)
 * lets the router consume `fwops:returnTo`.
 */
export function openSignIn(): void {
  requireClerk().openSignIn({ appearance });
}

/**
 * Mount the Clerk prebuilt user button (avatar + sign-out menu) into `node`.
 * `node` is an `HTMLDivElement` (clerk-js v6 `mountUserButton` requires a div).
 */
export function mountUserButton(node: HTMLDivElement): void {
  requireClerk().mountUserButton(node, { appearance });
}

/** Sign the current user out (AUTH-02). */
export async function signOut(): Promise<void> {
  await requireClerk().signOut();
}

/**
 * Subscribe to Clerk auth-state changes (sign-in / sign-out). The router uses
 * this to re-render / consume the stashed return path once a modal sign-in
 * completes. Returns the Clerk-provided unsubscribe function.
 */
export function onAuthChange(cb: () => void): () => void {
  return requireClerk().addListener(() => cb());
}

/**
 * The app auth guard (AUTH-01/02, LOBBY-05). Returns `true` if a Clerk session is
 * active. Otherwise it STASHES `intendedPath` in sessionStorage (`fwops:returnTo`)
 * and triggers the sign-in surface, then returns `false`. The router consumes the
 * stash AFTER a successful sign-in so a share-link / deep route survives the
 * sign-in round-trip and lands the user where they intended.
 */
export function requireAuth(intendedPath: string): boolean {
  if (isSignedIn()) return true;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, intendedPath);
  } catch {
    // sessionStorage unavailable (private mode) — return-to just won't persist.
  }
  openSignIn();
  return false;
}

/**
 * Read and CLEAR the stashed return path (the destination an unauthenticated
 * visitor was trying to reach). Returns `null` if none. The router calls this
 * after a successful sign-in to navigate the user to their original destination.
 */
export function consumeReturnTo(): string | null {
  try {
    const path = sessionStorage.getItem(RETURN_TO_KEY);
    if (path) sessionStorage.removeItem(RETURN_TO_KEY);
    return path;
  } catch {
    return null;
  }
}
