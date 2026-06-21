import "./shell/shell.css";
import { initAuth } from "./shell/auth.js";
import { startRouter } from "./shell/router.js";

/**
 * Client entry (Phase 5, Plan 06). The app is now a multi-page web-app shell, NOT
 * a single Phaser canvas. main:
 *   1. imports shell.css so the design tokens / palette load (review MEDIUM);
 *   2. initializes Clerk (the shell gates every non-public route on a session);
 *   3. boots the framework-free mini-router.
 *
 * Phaser is NO LONGER instantiated here — it is mounted by the router ONLY on the
 * /play route (and dynamically imported there), so the lobby/landing DOM and a
 * live canvas never coexist (Pitfall 5).
 */
async function boot(): Promise<void> {
  await initAuth();
  startRouter();
}

void boot();
