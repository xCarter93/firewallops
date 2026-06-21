import type { Room } from "@colyseus/sdk";
import {
  createMatch,
  joinRoomById,
  reconnectToMatch,
  type NetHandlers,
} from "../../net/room.js";

/**
 * matchSession — THE SINGLE-OWNER MatchRoom connection manager (Blocker 3).
 *
 * This module-singleton owns AT MOST ONE `Room` at a time and is the ONLY seam any
 * page uses to join / reconnect / leave a MatchRoom. It exists so that ONE
 * connection survives the `/room/:id → /play/:id` transition: the room page
 * (plan 08) calls `join`/`create`, the play page (plan 09) reads `current` and
 * mounts Phaser against the SAME `Room` WITHOUT re-joining and WITHOUT leaving on
 * the room→play transition. Re-entering a room you are already in is idempotent
 * (the guard below) — it does NOT open a second seat / trigger a spurious
 * leave/forfeit (the duplicate-connection hazard the review flagged).
 *
 * It WRAPS `net/room.ts` (joinRoomById / createMatch / reconnectToMatch) — it does
 * NOT construct its own `@colyseus/sdk` `Client`. The lobby page's `/lobby`
 * LobbyRoom subscription is a SEPARATE, light connection (room-list push) and is
 * outside this manager — only the authoritative MatchRoom lives here.
 *
 * BLOCKER-3 INVARIANT: `room.leave()` is called in EXACTLY ONE place —
 * `leaveCurrent()`. No other method here, and no page anywhere, calls `leave()` on
 * the match room. Only navigating AWAY from the match flow (RETURN TO LOBBY / a
 * real quit) calls `leaveCurrent()`; the room→play transition NEVER does.
 */
class MatchSession {
  private room: Room | null = null;
  private roomId: string | null = null;

  /** The live MatchRoom, or `null` when no match is connected. */
  get current(): Room | null {
    return this.room;
  }

  /** The id of the live MatchRoom, or `null`. */
  get currentRoomId(): string | null {
    return this.roomId;
  }

  /**
   * Join an existing match room by id (share-link / lobby join), carrying the
   * Clerk token (AUTH-03). IDEMPOTENT: if we are ALREADY connected to this exact
   * room id, return the existing `Room` — re-entering the same room while already
   * connected does NOT open a second seat (the Blocker-3 idempotent-rejoin guard).
   * If a DIFFERENT room is currently held it is left first (a single owner holds
   * at most one room), then the new room is joined and stored.
   */
  async join(
    roomId: string,
    token: string,
    handlers: NetHandlers,
  ): Promise<Room> {
    if (this.room && this.roomId === roomId) {
      return this.room; // idempotent rejoin — no second seat
    }
    if (this.room) {
      await this.leaveCurrent(); // switching rooms — release the previous one
    }
    const room = await joinRoomById(roomId, token, handlers);
    this.room = room;
    this.roomId = room.roomId;
    return room;
  }

  /**
   * Create a NEW match room (lobby "CREATE ROOM"), carrying the Clerk token. Any
   * previously-held room is left first (single owner). Stores and returns the new
   * room.
   */
  async create(
    name: string,
    mode: string,
    token: string,
    handlers: NetHandlers,
  ): Promise<Room> {
    if (this.room) {
      await this.leaveCurrent();
    }
    const room = await createMatch({ name, mode, token }, handlers);
    this.room = room;
    this.roomId = room.roomId;
    return room;
  }

  /**
   * Resume a match after a hard reload of `/play/:roomId` (RECON-02) via the
   * room-scoped reconnection token persisted by net/room.ts. Returns the resumed
   * `Room` (stored as current) or `null` if there is no stored token / the
   * reconnect failed (window expired / room disposed) — the caller then falls back
   * to a fresh join or drops to the lobby.
   */
  async reconnect(roomId: string, handlers: NetHandlers): Promise<Room | null> {
    const room = await reconnectToMatch(roomId, handlers);
    if (room) {
      this.room = room;
      this.roomId = room.roomId;
    }
    return room;
  }

  /**
   * Leave the current match and clear ownership. THE ONLY place a match `leave()`
   * is called (Blocker-3 invariant). Idempotent — safe to call with no current
   * room. The room→play TRANSITION must NEVER call this (the play page reuses
   * `current`); only navigating AWAY from the match flow (RETURN TO LOBBY / quit)
   * calls it.
   */
  async leaveCurrent(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.roomId = null;
    if (room) {
      await room.leave();
    }
  }
}

/** The single-owner MatchRoom session manager (one connection across /room → /play). */
export const matchSession = new MatchSession();
