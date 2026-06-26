/**
 * @firewallops/server entrypoint.
 *
 * Wires the Colyseus 0.17 game server to its built-in Express integration so the
 * co-located Meta API `/internal/*` stub routes share one process (and one port)
 * with the WebSocket transport.
 *
 * WIRING (verified against the installed @colyseus/core 0.17.43 + @colyseus/ws-transport
 * type surface — NOT the pre-0.17 `new Server({ server })` form, which 0.17 removed):
 *   - `ServerOptions.transport` takes a `WebSocketTransport` (re-exported from `colyseus`).
 *   - `ServerOptions.express(app)` is the documented hook to configure Express routes;
 *     the transport initialises the Express-compatible app and hands it back here, so
 *     `registerHealthRoute(app)` + `registerMetaRoutes(app)` mount on the same HTTP server.
 *   - `ServerOptions.presence`/`.driver` wire Redis ONLY when REDIS_URL is set.
 *   - `ServerOptions.beforeListen` runs the bounded boot connectivity checks.
 *   - `gameServer.listen(PORT, host)` owns the HTTP server lifecycle (no manual
 *     `http.createServer` needed) and binds the dual-stack `::` host (Railway).
 *
 * DEPLOY (Plan 04-03): PORT/BIND_HOST are env-driven; the bind host hard-defaults
 * to the dual-stack `::` via a DEDICATED `BIND_HOST` env — NOT the generic
 * `HOSTNAME`, which Docker/Railway set to the container hostname (Codex concern
 * #4) — and is NEVER `0.0.0.0` (IPv4-only is unreachable on Railway's dual-stack
 * private network). Redis presence/driver are wired only when `REDIS_URL` is set,
 * so local dev (no env) keeps the in-memory default. `buildServer()` is exported
 * so the boot-smoke test boots the EXACT production wiring; the auto-listen is
 * guarded to the main module so importing the factory in a test does not
 * double-listen.
 */
import { Server, WebSocketTransport } from "colyseus";
import type { Application } from "express";
import { registerMetaRoutes } from "./meta/routes.js";
import { registerHealthRoute, runBootChecks } from "./health.js";
import { resolveRedisWiring } from "./redis.js";
import { MatchRoom } from "./rooms/MatchRoom.js";
import { LobbyRoom } from "./rooms/LobbyRoom.js";

/**
 * Resolve the listen port from `process.env.PORT` (default 2567 — clients connect
 * to ws://localhost:2567 locally).
 */
export function resolvePort(): number {
  return Number(process.env.PORT ?? 2567);
}

/**
 * Resolve the bind host (Codex concern #4). Hard-defaults to the dual-stack `::`
 * (Railway requires `::`, NOT `0.0.0.0`). A DEDICATED `BIND_HOST` env overrides
 * it; the generic `HOSTNAME` (the container hostname on Docker/Railway) is
 * deliberately NOT honored for the bind.
 */
export function resolveBindHost(): string {
  return process.env.BIND_HOST ?? "::";
}

/** Default Colyseus WS port — exported for back-compat with existing imports. */
export const PORT = resolvePort();

/**
 * Build the configured Colyseus `Server` (the EXACT production wiring). Exported
 * so the boot-smoke test can boot it on an ephemeral port without going through
 * the auto-listen path.
 */
export function buildServer(): Server {
  const redisUrl = process.env.REDIS_URL; // still boot-checked for liveness below.
  // Colyseus presence/driver: IN-MEMORY by default (single-replica Railway). Redis
  // presence/driver is OPT-IN via COLYSEUS_MULTI_REPLICA=1 — it is ONLY needed to
  // coordinate MULTIPLE server instances. On a single replica it adds nothing but
  // cross-process IPC + a `processId` registry kept in a PERSISTED Redis (RDB), whose
  // stale entries survive restarts and make matchmaking/reconnect route to dead
  // processes ("ipc_timeout: create room request timed out …" → reconnect fails →
  // forfeit). So we do NOT wire Redis unless explicitly multi-replica, even when
  // REDIS_URL is set (the boot check still pings Redis for liveness — it is simply
  // not used for presence/driver). Scaling past one instance: set the flag.
  const multiReplica = process.env.COLYSEUS_MULTI_REPLICA === "1";
  const redisWiring = multiReplica ? resolveRedisWiring(redisUrl) : null;

  const gameServer = new Server({
    transport: new WebSocketTransport(),
    // In-memory presence/driver unless COLYSEUS_MULTI_REPLICA=1 (see above).
    ...(redisWiring
      ? { presence: redisWiring.presence, driver: redisWiring.driver }
      : {}),
    gracefullyShutdown: true,
    express: (app: Application) => {
      registerHealthRoute(app);
      registerMetaRoutes(app);
    },
    beforeListen: async () => {
      await runBootChecks(redisUrl);
    },
  });

  // The built-in LobbyRoom is registered ABOVE the match room so its `$lobby`
  // presence subscription is live before any MatchRoom publishes metadata
  // (LOBBY-01/02). We do NOT call `.enableRealtimeListing()` (Assumption A1) —
  // each MatchRoom publishes EXPLICITLY via `setMetadata` + `updateLobby`.
  gameServer.define("lobby", LobbyRoom);
  gameServer.define("match", MatchRoom);
  return gameServer;
}

/**
 * Process-level diagnostics + resilience (Phase 08 auto-boot investigation).
 *
 * The auto-boot symptom presented as every client dropping with WS code 1001
 * ("going away") — the signature of the CONTAINER being stopped, not a tab
 * suspend. These handlers make the next occurrence conclusive AND stop a single
 * bad async path from taking the whole process (and every live match) down:
 *
 *   - SIGTERM/SIGINT: log the receipt with a timestamp. If this line appears,
 *     the platform (Railway) is stopping the container EXTERNALLY (deploy,
 *     restart, healthcheck failure, or OOM-kill) — NOT a self-crash. This is an
 *     additive listener; Colyseus's own `gracefullyShutdown` handler still runs.
 *   - unhandledRejection / uncaughtException: log the full reason/stack and
 *     SWALLOW it (do not exit). For a real-time game server, a process exit boots
 *     every connected player, so we deliberately prefer staying up + logging over
 *     the Node default of terminating. If a crash WAS the boot cause, this both
 *     stops it and reveals the culprit in the logs.
 */
function installProcessGuards(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.warn(
        `[server] ${signal} received at ${new Date().toISOString()} — the platform is stopping this container EXTERNALLY (deploy / restart / healthcheck / OOM). Every client socket will close with code 1001. This is NOT a tab suspend.`,
      );
    });
  }
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[server] unhandledRejection (swallowed — kept process alive to avoid booting live matches):",
      reason,
    );
  });
  process.on("uncaughtException", (err) => {
    console.error(
      "[server] uncaughtException (swallowed — kept process alive to avoid booting live matches):",
      err,
    );
  });
}

/**
 * Start the server on the resolved port + bind host. Only invoked as the main
 * module (the real `pnpm start` / container entrypoint), so test imports of
 * `buildServer()` do not double-listen.
 */
async function main(): Promise<void> {
  installProcessGuards();
  const port = resolvePort();
  const host = resolveBindHost();
  const gameServer = buildServer();
  await gameServer.listen(port, host);
  console.log(`[server] Colyseus listening on ${host}:${port}`);
}

// Auto-listen only when run as the entrypoint (tsx src/index.ts), not on import.
const isMain = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return (
      entry.endsWith("index.ts") ||
      entry.endsWith("index.js") ||
      entry.includes("/server/src/index")
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  void main();
}
