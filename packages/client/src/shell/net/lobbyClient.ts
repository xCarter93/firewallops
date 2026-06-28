import { Client, type RoomAvailable } from "@colyseus/sdk";
import { SERVER_URL } from "../../net/room.js";

/**
 * lobbyClient — the LIGHT LobbyRoom subscription (Phase 5, Plan 08, LOBBY-01/02).
 *
 * The lobby page holds a SEPARATE, light Colyseus connection to the built-in
 * `"lobby"` room (registered server-side in 05-04) purely to receive the live
 * room-list PUSH. This is intentionally NOT the single-owner `matchSession`
 * connection: the lobby connection is room-list metadata only and is NOT a match
 * seat, so it is fine for it to live outside the matchSession manager. The
 * authoritative MatchRoom seat is created/joined exclusively through
 * `matchSession.create` / `matchSession.join` (Blocker 3) — never here.
 *
 * The built-in Colyseus LobbyRoom pushes three message kinds over the joined
 * lobby room (verified against the installed @colyseus/sdk 0.17.43 Room API):
 *   - "rooms" → the FULL current list of available rooms (RoomAvailable[]).
 *   - "+"     → an upsert: `[roomId, RoomAvailable]` (a room appeared / changed).
 *   - "-"     → a removal: `roomId` (a room closed / left matchmaking).
 * We keep a local mirror, fold each push into it, and notify the caller with the
 * up-to-date list. We use ONLY this push subscription — never the absent one-shot
 * matchmaking query (Pitfall 1: not present on this installed client).
 *
 * The match server publishes each MatchRoom's joinable metadata
 * (name / mode / players / maxPlayers / readyCount / locked / phase) via
 * `setMetadata(...) + updateLobby(this)` (05-04). Each `RoomAvailable.metadata`
 * carries that shape; the lobby page reads it to render name/mode/count/locked.
 */

/** The joinable metadata each MatchRoom publishes (05-04 `refreshListing`). */
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

/** A room row as surfaced to the lobby page: the SDK `RoomAvailable` + our metadata. */
export type LobbyRoomEntry = RoomAvailable<LobbyRoomMetadata>;

/** The handle the lobby page uses to tear the subscription down on nav-away. */
export interface LobbySubscription {
  /** Leave the lobby room and stop receiving room-list pushes. */
  close(): void;
}

/**
 * Subscribe to the live LobbyRoom room list. Opens a light connection to the
 * built-in `"lobby"` room, mirrors the pushed list locally, folds in every
 * `"rooms"` / `"+"` / `"-"` push, and calls `onRooms` with the current list each
 * time it changes (and once on the initial snapshot). Returns a `close()` that
 * leaves the lobby room.
 */
export async function subscribeLobby(
  onRooms: (rooms: LobbyRoomEntry[]) => void,
): Promise<LobbySubscription> {
  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate("lobby");

  // Local mirror of the room list, kept in sync by the three pushes below.
  let rooms: LobbyRoomEntry[] = [];

  const emit = (): void => onRooms([...rooms]);

  // Full snapshot — replace the local mirror outright.
  room.onMessage("rooms", (all: LobbyRoomEntry[]) => {
    rooms = all;
    emit();
  });

  // Upsert — a room appeared or its metadata changed. Payload is [roomId, room].
  room.onMessage("+", ([roomId, room]: [string, LobbyRoomEntry]) => {
    const idx = rooms.findIndex((r) => r.roomId === roomId);
    if (idx === -1) {
      rooms = [...rooms, room];
    } else {
      rooms = rooms.map((r, i) => (i === idx ? room : r));
    }
    emit();
  });

  // Removal — a room closed / left matchmaking. Payload is the roomId.
  room.onMessage("-", (roomId: string) => {
    rooms = rooms.filter((r) => r.roomId !== roomId);
    emit();
  });

  return {
    close(): void {
      // Leaving the lobby room is NOT a match leave — this is the light room-list
      // connection, entirely outside the matchSession seat manager (Blocker 3).
      void room.leave();
    },
  };
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
