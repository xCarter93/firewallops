/**
 * LobbyRoom registration (Phase 5, Plan 04) — LOBBY-01/02.
 *
 * Re-exports the Colyseus BUILT-IN `LobbyRoom`. This thin wrapper file keeps the
 * registration import local to the app (`index.ts` imports from here, not from
 * `@colyseus/core` directly), so a future CUSTOM lobby (filtering/sorting the
 * published room list) can slot in by changing only this file — no edit to
 * `index.ts` or any consumer.
 *
 * The built-in LobbyRoom subscribes to the `$lobby` presence channel and pushes
 * the live room list to connected lobby clients. Each `MatchRoom` publishes its
 * joinable metadata via `setMetadata(...)` FOLLOWED BY `updateLobby(this)` — the
 * `updateLobby` call is what notifies this room (Pitfall 1: `setMetadata` alone
 * does NOT notify the lobby). We deliberately do NOT call
 * `.enableRealtimeListing()` (Assumption A1: unverified on 0.17 — rooms publish
 * EXPLICITLY via `updateLobby`).
 */
export { LobbyRoom } from "@colyseus/core";
