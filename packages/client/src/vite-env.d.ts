/// <reference types="vite/client" />

/**
 * Typed Vite build-time envs for the client bundle (Phase 4, Plan 02).
 *
 * Vite inlines `import.meta.env.VITE_*` at BUILD time, so these must be declared
 * for the production typecheck to pass. Both are optional (`?`) because local DEV
 * runs with neither set:
 *
 * - VITE_SERVER_URL  — the authoritative game-server URL (`wss://<service>.up.railway.app`
 *   in the deploy; `net/room.ts` falls back to `ws://localhost:2567` in DEV and
 *   throws in PROD if missing — review concern #11). Set in Vercel at deploy time
 *   (Plan 05).
 * - VITE_NETWORKED   — "1"/"true" selects the real networked match over the
 *   documented-non-functional hotseat dev default (`MatchScene.ts` reads it). The
 *   deployed Vercel build sets this to "1" (review C2); set in Vercel (Plan 05).
 * - VITE_CLERK_PUBLISHABLE_KEY — the Clerk publishable key (`pk_...`) the vanilla
 *   `@clerk/clerk-js` `new Clerk(...)` ctor needs (Phase 5, Plan 06). MUST be
 *   `VITE_`-prefixed so Vite inlines it into the browser bundle at build time
 *   (a non-`VITE_` key would be `undefined` in the static bundle). Set in the
 *   client `.env` (DEV) and in Vercel (deploy) — Clerk Dashboard → API keys.
 * - VITE_SERVER_HTTP_URL — the HTTPS base for the REST Meta-API (`/internal/profile`,
 *   profile reads/writes). This is DISTINCT from `VITE_SERVER_URL` (the `wss://` WS
 *   URL `new Client()` uses): the Meta-API is plain HTTPS, the game server is WS.
 *   e.g. `https://<railway-host>`. Confirm the server's `CORS_ORIGINS` allows the
 *   client origin. Set in the client `.env` (DEV) and in Vercel (deploy).
 */
interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  readonly VITE_NETWORKED?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_SERVER_HTTP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
