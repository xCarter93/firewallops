/**
 * lobbyClient — the live open-room list for the lobby page (Phase 5/9, LOBBY-01/02).
 *
 * The room list is served by the reactive Convex `api.lobby.listOpen` query
 * (`subscribeLobbyConvex`): it re-pushes whenever any open/full room's
 * status/roster/phase changes — no manual fold. The Colyseus LobbyRoom push
 * subscription was removed at the plan-12 cutover. Each row is mapped to the
 * `LobbyRoomEntry` shape the lobby page renderer consumes unchanged.
 */

/** The joinable metadata each room publishes (mapped from `listOpen`). */
export interface LobbyRoomMetadata {
  name: string;
  mode: string;
  map: string;
  players: number;
  maxPlayers: number;
  readyCount: number;
  locked: boolean;
  phase: string;
}

/** A room row as surfaced to the lobby page (mapped from `api.lobby.listOpen`). */
export interface LobbyRoomEntry {
  roomId: string;
  clients: number;
  maxClients: number;
  metadata: LobbyRoomMetadata;
}

/** The handle the lobby page uses to tear the subscription down on nav-away. */
export interface LobbySubscription {
  /** Leave the lobby room and stop receiving room-list pushes. */
  close(): void;
}

// ───────────────────────────── Convex lobby subscription (Phase 9, plan 06) ─────────────────────────────
//
// The pure-Convex replacement for the Colyseus LobbyRoom subscription above. It does
// NOT remove the Colyseus `subscribeLobby` (the lobby page still imports it on this
// branch until the plan-12 cutover) — the two coexist exactly as `convexClient.ts`
// coexists with `net/room.ts`.
//
// `api.lobby.listOpen` is a REACTIVE Convex query (plan 04): the list re-pushes
// whenever any open/full room's status/roster/phase changes — no manual "+"/"-"
// folding (Convex re-runs the query and re-fires the callback). To keep the lobby
// page renderer (`renderRoomRow`, lobby.ts:664) UNCHANGED, each `listOpen` row is
// mapped into the SAME `LobbyRoomEntry` shape the page already reads
// (`room.roomId` + `room.metadata.{name,mode,players,maxPlayers,locked,phase}` +
// `room.clients`/`room.maxClients`). `accountId` never appears in `listOpen` (R2).

import { api } from "@firewallops/convex/api";
import { getConvexClient } from "../../net/convexClient.js";

/** One open/full room as returned by `api.lobby.listOpen` (plan 04 shape). */
interface ListOpenRow {
  matchId: string;
  name: string;
  mode: string;
  players: number;
  maxPlayers: number;
  readyCount: number;
  locked: boolean;
  phase: string;
}

/**
 * Adapt a Convex `listOpen` row to the `LobbyRoomEntry` shape the lobby page
 * renderer consumes UNCHANGED (the Convex matchId becomes `roomId`; counts map to
 * `clients`/`maxClients`; the display fields go on `metadata`). `map` is absent in
 * the Convex shape (single-map game) — defaulted so `LobbyRoomMetadata` is total.
 */
function rowToEntry(r: ListOpenRow): LobbyRoomEntry {
  return {
    roomId: r.matchId,
    clients: r.players,
    maxClients: r.maxPlayers,
    metadata: {
      name: r.name,
      mode: r.mode,
      map: "default",
      players: r.players,
      maxPlayers: r.maxPlayers,
      readyCount: r.readyCount,
      locked: r.locked,
      phase: r.phase,
    },
  } as LobbyRoomEntry;
}

/**
 * Subscribe to the live open-room list via the reactive `api.lobby.listOpen` query
 * (the Convex replacement for `subscribeLobby`). Calls `onRooms` with the current
 * list (mapped to `LobbyRoomEntry[]`) on the initial result and on every change.
 * Returns the SAME `LobbySubscription` `close()` contract the page already uses
 * (here it just unsubscribes the query — there is no lobby seat to leave).
 */
export function subscribeLobbyConvex(
  onRooms: (rooms: LobbyRoomEntry[]) => void,
): LobbySubscription {
  const unsub = getConvexClient().onUpdate(api.lobby.listOpen, {}, (raw) => {
    const rows = raw as ListOpenRow[];
    onRooms(rows.map(rowToEntry));
  });
  return {
    close(): void {
      unsub();
    },
  };
}
