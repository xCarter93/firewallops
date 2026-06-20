/**
 * Redis wiring factory (DEPLOY-04).
 *
 * Returns the Colyseus `RedisPresence` + `RedisDriver` pair ONLY when a
 * `REDIS_URL` is provided; returns `null` (the "in-memory" decision) when it is
 * undefined, so local dev keeps Colyseus's default in-memory presence/driver and
 * is completely unaffected by this phase.
 *
 * The `REDIS_URL` is consumed VERBATIM. On Railway the value is the Redis
 * service's private reference (`${{ Redis.REDIS_URL }}`, set in Plan 05) and
 * Railway's environments are dual-stack — so, unlike the superseded Fly path, we
 * do NOT append `?family=6` (04-RESEARCH-RAILWAY.md §4). Both constructors accept
 * a `redis://` URL string directly (RESEARCH Pattern 2; verified against the
 * installed @colyseus/redis-* 0.17.7 type surface).
 */
import { RedisPresence } from "@colyseus/redis-presence";
import { RedisDriver } from "@colyseus/redis-driver";

export interface RedisWiring {
  presence: RedisPresence;
  driver: RedisDriver;
}

/**
 * Build the Colyseus Redis presence/driver pair from a `redis://` URL, or return
 * `null` when no URL is configured (in-memory default — local dev).
 */
export function resolveRedisWiring(redisUrl?: string): RedisWiring | null {
  if (!redisUrl) return null;
  return {
    presence: new RedisPresence(redisUrl),
    driver: new RedisDriver(redisUrl),
  };
}
