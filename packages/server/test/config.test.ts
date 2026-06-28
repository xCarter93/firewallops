import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolvePort, resolveBindHost } from "../src/index.js";
import { resolveRedisWiring } from "../src/redis.js";
import { teamSizeForMode } from "@firewallops/match-core";

/**
 * Wave-0 config-resolution test (DEPLOY-02 / DEPLOY-04 / Codex concern #4).
 *
 * Locks the env→config seam the deployed container depends on:
 *   - PORT resolution (default 2567, override honored).
 *   - BIND_HOST resolution: hard-default `::` (dual-stack — Railway needs `::`,
 *     NOT `0.0.0.0`); a DEDICATED `BIND_HOST` env overrides it; the generic
 *     `HOSTNAME` (which Docker/Railway set to the container hostname) is NOT
 *     honored for the bind (Codex concern #4).
 *   - The Redis wiring decision: no `REDIS_URL` → in-memory (null); `REDIS_URL`
 *     set → a redis wiring object. The URL is passed VERBATIM — no `?family=6`
 *     appended (04-RESEARCH-RAILWAY.md §4 — Railway is dual-stack, no family flag).
 */
describe("config: PORT / BIND_HOST / Redis-wiring resolution", () => {
  const ENV_KEYS = ["PORT", "BIND_HOST", "HOSTNAME", "REDIS_URL"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // ── PORT ──
  it("PORT unset → 2567", () => {
    expect(resolvePort()).toBe(2567);
  });

  it('PORT="8080" → 8080', () => {
    process.env.PORT = "8080";
    expect(resolvePort()).toBe(8080);
  });

  // ── BIND_HOST (Codex concern #4) ──
  it("BIND_HOST unset → bind host is the dual-stack `::`", () => {
    expect(resolveBindHost()).toBe("::");
  });

  it('BIND_HOST="::1" → "::1" (override honored)', () => {
    process.env.BIND_HOST = "::1";
    expect(resolveBindHost()).toBe("::1");
  });

  it("HOSTNAME set + BIND_HOST unset → bind host is STILL `::` (HOSTNAME ignored)", () => {
    // Docker/Railway set HOSTNAME to the container hostname — it must NOT leak
    // into the bind address (Codex concern #4).
    process.env.HOSTNAME = "some-container-id";
    expect(resolveBindHost()).toBe("::");
  });

  // ── Redis wiring decision ──
  it("REDIS_URL unset → in-memory (no Redis wiring constructed)", () => {
    expect(resolveRedisWiring(undefined)).toBeNull();
  });

  it("REDIS_URL set → a redis wiring object with presence + driver", () => {
    const wiring = resolveRedisWiring("redis://localhost:6379");
    expect(wiring).not.toBeNull();
    expect(wiring?.presence).toBeDefined();
    expect(wiring?.driver).toBeDefined();
  });

  it("REDIS_URL is consumed verbatim — `?family=6` is NOT appended", () => {
    // Railway is dual-stack; the verbatim URL must reach ioredis unchanged.
    const url = "redis://redis.railway.internal:6379";
    const wiring = resolveRedisWiring(url);
    expect(wiring).not.toBeNull();
    // The factory must not mutate/append a family flag onto the URL it receives.
    expect(url).not.toContain("family");
  });
});

/**
 * Per-mode team-size lock (Phase 8, TR-2). `teamSizeForMode` is the single source
 * of the per-team seat count; the `"training"` mode adds a single-human (teamSize
 * 1) mode. Re-asserting the competitive modes locks the MatchMode union change so
 * a future edit can't silently drift one of them.
 */
describe("teamSizeForMode", () => {
  it('"training" is a single-human mode → teamSize 1', () => {
    expect(teamSizeForMode("training")).toBe(1);
  });

  it("competitive modes are unchanged (1v1→1, 2v2→2, 4v4→4)", () => {
    expect(teamSizeForMode("1v1")).toBe(1);
    expect(teamSizeForMode("2v2")).toBe(2);
    expect(teamSizeForMode("4v4")).toBe(4);
  });
});
