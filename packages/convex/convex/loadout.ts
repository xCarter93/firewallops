/**
 * Loadout read seam (Phase 9, Plan 09-11, review [A1]) — the Convex replacement
 * for the REST `GET /internal/loadout/:accountId` (server/src/meta/loadout.ts).
 *
 * v0 returns the SAME defaults for every caller; real avatar/economy resolution is
 * post-v0 (the seam exists, not the logic). Unlike the REST route — which took the
 * accountId as a PATH PARAM — this is an AUTHED query keyed off the caller's own
 * identity: the id is now the verified subject, never a client-supplied value
 * (D-08). The three default ids mirror the client loadout (`shot-1`, `shot-2`,
 * `trojan`) and are ported VERBATIM from the server `DEFAULT_LOADOUT` stub.
 */
import { query } from "./_generated/server";

/**
 * The v0 default loadout (ported verbatim from `server/src/meta/loadout.ts`
 * `DEFAULT_LOADOUT`). Returned for every caller until the real economy lands.
 */
export const DEFAULT_LOADOUT = {
  items: ["shot-1", "shot-2", "trojan"] as const,
};

/**
 * Authed loadout READ. Rejects when `getUserIdentity()` is null (no leak); returns
 * the default loadout for the caller. The accountId is intentionally NOT read here
 * (v0 returns the same defaults for everyone) but auth is still required so the
 * surface matches the rest of the authed Meta-API and is ready for per-account
 * resolution later.
 */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    return { items: [...DEFAULT_LOADOUT.items] };
  },
});
