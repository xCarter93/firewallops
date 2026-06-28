/// <reference types="vite/client" />

/**
 * Typed Vite build-time envs for the client bundle (Phase 4, Plan 02).
 *
 * Vite inlines `import.meta.env.VITE_*` at BUILD time, so these must be declared
 * for the production typecheck to pass. All are optional (`?`) because local DEV may
 * run without them:
 *
 * - VITE_CONVEX_URL — the Convex deployment URL (`https://<deployment>.convex.cloud`)
 *   the Convex client connects to. Set in the client `.env` (DEV) and in Vercel
 *   (deploy) — Convex Dashboard → deployment URL.
 * - VITE_CLERK_PUBLISHABLE_KEY — the Clerk publishable key (`pk_...`) the vanilla
 *   `@clerk/clerk-js` `new Clerk(...)` ctor needs (Phase 5, Plan 06). MUST be
 *   `VITE_`-prefixed so Vite inlines it into the browser bundle at build time
 *   (a non-`VITE_` key would be `undefined` in the static bundle). Set in the
 *   client `.env` (DEV) and in Vercel (deploy) — Clerk Dashboard → API keys.
 * - VITE_DOM_HUD — selects the DOM HUD overlay (Phase 6 HUD migration). Default
 *   ON: the consumer reads `import.meta.env.VITE_DOM_HUD !== "0"`, so the string
 *   "0" is the ONLY off-switch (never test truthiness of the raw string — an
 *   unset value, "", or any other string all mean ON). When ON, the networked
 *   `new Hud(..., { domHud: true })` suppresses the migrated Phaser widgets so the
 *   DOM overlay owns the HUD without a competing canvas draw; `VITE_DOM_HUD=0`
 *   falls back to the legacy Phaser HUD.
 */
interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_DOM_HUD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
