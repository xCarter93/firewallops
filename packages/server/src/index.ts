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
 *     `registerMetaRoutes(app)` mounts `/internal/*` on the same HTTP server.
 *   - `gameServer.listen(PORT)` owns the HTTP server lifecycle (no manual
 *     `http.createServer` needed).
 * Importing `Server` + `WebSocketTransport` from `colyseus` (a direct dep that
 * re-exports both) avoids depending on the transitive `@colyseus/ws-transport` path.
 */
import { Server, WebSocketTransport } from "colyseus";
import type { Application } from "express";
import { registerMetaRoutes } from "./meta/routes.js";
import { MatchRoom } from "./rooms/MatchRoom.js";

/** Default Colyseus WS port — clients connect to ws://localhost:2567 (Plan 04). */
export const PORT = 2567;

const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: (app: Application) => {
    registerMetaRoutes(app);
  },
});

gameServer.define("match", MatchRoom);

gameServer.listen(PORT).then(() => {
  console.log(`[server] Colyseus listening on ws://localhost:${PORT}`);
});
