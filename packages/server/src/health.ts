/**
 * /health route + bounded boot connectivity checks (DEPLOY-04 / Codex concerns
 * #5, #8 / review H5).
 *
 * `registerHealthRoute` mounts a cheap `GET /health` 200 (the platform's HTTP
 * health-check target). `runBootChecks` is the boot gate: it pings the configured
 * dependencies and THROWS to fail boot if a configured dependency is unreachable
 * — Railway's `on-failure` restart then retries.
 *
 * DEPLOY-MODE GUARD (concern #5): with `REQUIRE_DEPLOY_DEPS=true`, a MISSING
 * REDIS_URL or CONVEX_URL fails boot fast — a deployed server must not boot green
 * having checked neither dependency.
 *
 * BOUNDED REDIS CHECK (concern #8): the ioredis client uses a short connect
 * timeout, no retry, and `disconnect()` in a `finally`, so a down Redis fails
 * fast and never leaks a socket.
 *
 * HONEST LOGGING (concern #5): the returned summary names each check `ok`
 * (ran + passed) or `skipped` (env unset) — it NEVER claims a skipped dependency
 * is reachable.
 */
import type { Application } from "express";
import Redis from "ioredis";
import { pingConvex } from "./convex.js";

export function registerHealthRoute(app: Application): void {
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });
}

export interface BootCheckSummary {
  redis: "ok" | "skipped";
  convex: "ok" | "skipped";
}

/**
 * Run the bounded boot connectivity checks. Resolves with a ran-vs-skipped
 * summary; throws if a configured dependency is unreachable OR (in deploy mode) a
 * required dependency env is absent.
 */
export async function runBootChecks(redisUrl?: string): Promise<BootCheckSummary> {
  const requireDeps = process.env.REQUIRE_DEPLOY_DEPS === "true";
  const convexUrl = process.env.CONVEX_URL;

  // Deploy-mode guard (concern #5): fail fast on a missing REQUIRED env.
  if (requireDeps && !redisUrl) {
    throw new Error("REDIS_URL required in deploy mode (REQUIRE_DEPLOY_DEPS=true)");
  }
  if (requireDeps && !convexUrl) {
    throw new Error("CONVEX_URL required in deploy mode (REQUIRE_DEPLOY_DEPS=true)");
  }

  const summary: BootCheckSummary = { redis: "skipped", convex: "skipped" };

  // Bounded Redis check (concern #8).
  if (redisUrl) {
    const r = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    try {
      await r.connect();
      await r.ping();
      summary.redis = "ok";
    } finally {
      r.disconnect();
    }
  }

  // Convex check — self-skips when CONVEX_URL is unset.
  if (convexUrl) {
    await pingConvex();
    summary.convex = "ok";
  }

  // Honest log: report what actually RAN; never "reachable" for a skipped check.
  console.log(
    `[server] boot checks: redis=${summary.redis} convex=${summary.convex}`,
  );

  return summary;
}
