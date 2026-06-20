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
 */
interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  readonly VITE_NETWORKED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
