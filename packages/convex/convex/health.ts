import { query } from "./_generated/server";

/**
 * Boot health-check query (review H5).
 *
 * BOUNDED probe: uses an indexed take(1) so it reads at most ONE row and never
 * scans toward Convex's 32,000-doc-per-transaction cap. It MUST NOT read the whole
 * accounts table unbounded — an unbounded full-table read on a growing table would
 * eventually trip the scan cap and turn the boot health check into a false outage
 * (the exact H5 anti-pattern).
 *
 * The Plan-03 server reaches this as `api.health.ping` via `ConvexHttpClient`.
 */
export const ping = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("accounts").take(1);
    return { ok: true, hasRows: rows.length > 0 };
  },
});
