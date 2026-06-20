import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

/**
 * Wave-0 boot-checks test (DEPLOY-04 / Codex concerns #5, #8 / review H5).
 *
 * `runBootChecks(redisUrl?)` is the boot gate. It must:
 *   - SKIP a check whose env is unset (local dev: no REDIS_URL/CONVEX_URL → both
 *     pings skipped, resolves), and report it as `skipped` (never `ok`/reachable).
 *   - RUN + pass the Redis ping when REDIS_URL is set (mocked ioredis), and
 *     REJECT when the ping rejects (bounded — concern #8).
 *   - REJECT when the Convex ping rejects.
 *   - DEPLOY-MODE GUARD (concern #5): with REQUIRE_DEPLOY_DEPS="true", a missing
 *     REDIS_URL or CONVEX_URL FAILS boot fast; both present (mocks resolving) →
 *     resolves.
 *   - HONEST LOGGING (concern #5): the returned summary names each check `ok`
 *     (ran+passed) or `skipped` (env unset) — never claims a skipped dep reachable.
 *
 * ioredis is mocked so no live Redis is needed; `./convex.js` pingConvex is
 * mocked so no live Convex is needed.
 */

// ── ioredis mock: a bounded client whose ping() is controllable per test. ──
const redisPing = vi.fn<() => Promise<string>>(() => Promise.resolve("PONG"));
const redisConnect = vi.fn<() => Promise<void>>(() => Promise.resolve());
const redisDisconnect = vi.fn<() => void>(() => undefined);

vi.mock("ioredis", () => {
  return {
    default: class FakeRedis {
      connect = redisConnect;
      ping = redisPing;
      disconnect = redisDisconnect;
    },
  };
});

// ── convex.ts mock: pingConvex is controllable per test. ──
const pingConvexMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
vi.mock("../src/convex.js", () => ({
  pingConvex: () => pingConvexMock(),
}));

import { runBootChecks } from "../src/health.js";

describe("health: runBootChecks (bounded + deploy-deps guard + honest logging)", () => {
  let savedConvex: string | undefined;
  let savedRequire: string | undefined;

  beforeEach(() => {
    savedConvex = process.env.CONVEX_URL;
    savedRequire = process.env.REQUIRE_DEPLOY_DEPS;
    delete process.env.CONVEX_URL;
    delete process.env.REQUIRE_DEPLOY_DEPS;
    redisPing.mockReset().mockResolvedValue("PONG");
    redisConnect.mockReset().mockResolvedValue(undefined);
    redisDisconnect.mockReset();
    pingConvexMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (savedConvex === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = savedConvex;
    if (savedRequire === undefined) delete process.env.REQUIRE_DEPLOY_DEPS;
    else process.env.REQUIRE_DEPLOY_DEPS = savedRequire;
  });

  // ── skip path (local dev) ──
  it("no REDIS_URL + no CONVEX_URL + REQUIRE_DEPLOY_DEPS unset → resolves, both skipped", async () => {
    const summary = await runBootChecks(undefined);
    expect(redisPing).not.toHaveBeenCalled();
    expect(pingConvexMock).not.toHaveBeenCalled();
    expect(summary.redis).toBe("skipped");
    expect(summary.convex).toBe("skipped");
  });

  // ── redis ran+passed / failed ──
  it("REDIS_URL set + ping resolves → resolves, redis=ok", async () => {
    const summary = await runBootChecks("redis://localhost:6379");
    expect(redisPing).toHaveBeenCalledOnce();
    expect(redisDisconnect).toHaveBeenCalled();
    expect(summary.redis).toBe("ok");
  });

  it("REDIS_URL set + ping rejects → rejects (and disconnects in finally)", async () => {
    redisPing.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(runBootChecks("redis://localhost:6379")).rejects.toThrow();
    expect(redisDisconnect).toHaveBeenCalled(); // cleanup in finally (concern #8)
  });

  // ── convex failure ──
  it("CONVEX_URL set + pingConvex rejects → rejects", async () => {
    process.env.CONVEX_URL = "https://example.convex.cloud";
    pingConvexMock.mockRejectedValueOnce(new Error("convex down"));
    await expect(runBootChecks(undefined)).rejects.toThrow();
  });

  it("CONVEX_URL set + pingConvex resolves → resolves, convex=ok", async () => {
    process.env.CONVEX_URL = "https://example.convex.cloud";
    const summary = await runBootChecks(undefined);
    expect(pingConvexMock).toHaveBeenCalledOnce();
    expect(summary.convex).toBe("ok");
  });

  // ── deploy-mode guard (concern #5) ──
  it('REQUIRE_DEPLOY_DEPS="true" + missing REDIS_URL → rejects', async () => {
    process.env.REQUIRE_DEPLOY_DEPS = "true";
    process.env.CONVEX_URL = "https://example.convex.cloud";
    await expect(runBootChecks(undefined)).rejects.toThrow();
  });

  it('REQUIRE_DEPLOY_DEPS="true" + missing CONVEX_URL → rejects', async () => {
    process.env.REQUIRE_DEPLOY_DEPS = "true";
    await expect(runBootChecks("redis://localhost:6379")).rejects.toThrow();
  });

  it('REQUIRE_DEPLOY_DEPS="true" + both set (pings resolve) → resolves', async () => {
    process.env.REQUIRE_DEPLOY_DEPS = "true";
    process.env.CONVEX_URL = "https://example.convex.cloud";
    const summary = await runBootChecks("redis://localhost:6379");
    expect(summary.redis).toBe("ok");
    expect(summary.convex).toBe("ok");
  });

  // ── honest logging (concern #5) ──
  it("a skipped check is reported `skipped`, never claimed reachable", async () => {
    // Only redis configured; convex must report skipped (NOT ok / NOT reachable).
    const summary = await runBootChecks("redis://localhost:6379");
    expect(summary.redis).toBe("ok");
    expect(summary.convex).toBe("skipped");
    expect(JSON.stringify(summary)).not.toContain("reachable");
  });
});
