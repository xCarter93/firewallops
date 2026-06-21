/**
 * The single server-side Convex writer accessor for the Meta-API (AUTH-04/05).
 *
 * `webhooks.ts` (provision) and `results.ts` (recordResult) BOTH route through
 * this one accessor so there is exactly ONE `ConvexHttpClient` for the whole
 * server. Rather than construct a second client, this delegates to the Phase-4
 * lazy singleton in `../convex.ts` (`convex()`, which reads `CONVEX_URL` and
 * memoizes the client) — no duplicate wiring, no duplicate client.
 *
 * Re-exports `api` from the convex workspace package so callers import the
 * function references + the client from one place.
 */
import { convex } from "../convex.js";
import type { ConvexHttpClient } from "convex/browser";

export { api } from "@firewallops/convex/api";

/** The shared lazy `ConvexHttpClient` (Phase-4 singleton). */
export function getConvex(): ConvexHttpClient {
  return convex();
}
