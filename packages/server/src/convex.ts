/**
 * Convex client + boot connectivity ping (DEPLOY-04 / review H5).
 *
 * A lazy `ConvexHttpClient` singleton (works in standalone Node — RESEARCH
 * Pattern 3, CITED docs.convex.dev/client/javascript) reading `CONVEX_URL`, and a
 * `pingConvex()` that proves the deployment is reachable at boot.
 *
 * IMPORT DISCIPLINE (Plan 01 / concern #1): Convex now lives in the
 * `@firewallops/convex` workspace package (a packages/server dependency), so
 * `api` is imported from the package export `@firewallops/convex/api` — NOT a
 * `../../../convex/_generated` relative path.
 *
 * BOUNDED PROBE (review H5): the ping calls the Plan-01 `health.ping` query, which
 * is an indexed `take(1)` — it reads at most one row and can never trip Convex's
 * 32k-doc scan cap. It MUST NOT be a `.collect()`/count query (the H5
 * anti-pattern that would turn the boot check into a false outage on a growing
 * table).
 *
 * When `CONVEX_URL` is unset (local dev / boot-smoke), `pingConvex()` resolves
 * immediately and constructs no client.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "@firewallops/convex/api";

let _client: ConvexHttpClient | null = null;

/**
 * The lazy `ConvexHttpClient` singleton. Throws if called without `CONVEX_URL`
 * set — callers (only `pingConvex` this phase) guard on the env first.
 */
export function convex(): ConvexHttpClient {
  if (!_client) {
    const url = process.env.CONVEX_URL;
    if (!url) throw new Error("CONVEX_URL not set");
    _client = new ConvexHttpClient(url);
  }
  return _client;
}

/**
 * Boot connectivity check. ONLY when `CONVEX_URL` is set, calls the BOUNDED
 * `api.health.ping` (review H5) to prove the deploy is reachable; rejects if the
 * query fails so `runBootChecks` can fail boot fast. No-op (resolves) when
 * `CONVEX_URL` is unset.
 */
export async function pingConvex(): Promise<void> {
  if (!process.env.CONVEX_URL) return;
  await convex().query(api.health.ping, {});
}
