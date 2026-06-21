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
