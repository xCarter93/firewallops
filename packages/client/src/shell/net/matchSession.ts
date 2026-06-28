import type { Room } from "@colyseus/sdk";
import {
  attachToMatch,
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
      // Idempotent rejoin — no second seat. BUT re-bind THIS caller's handlers to
      // the existing room: the connection was opened earlier (e.g. lobby CREATE
      // ROOM passes inert handlers), so without this the new page's onStateChange
      // (renderState) never fires and its seat list stays empty. Colyseus keys
      // listeners by type (last registration wins), so this cleanly hands the room
      // to the new page — the same mechanism the play page uses via attachToMatch.
      return attachToMatch(this.room, handlers);
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

// ───────────────────────────── Convex match session (Phase 9, plan 06) ─────────────────────────────
//
// The pure-Convex replacement for the Colyseus `MatchSession` above. It does NOT
// destructively replace it: the Colyseus `matchSession` is still consumed by the
// branch's room/play pages (room.ts/play.ts use `.current` as a Colyseus `Room`:
// `.send`/`.state`/`.onDrop`/`room.sessionId`), and those pages are NOT rewritten
// here (the plan-12 cutover deletes the Colyseus halves). So the two coexist on the
// branch exactly as `convexClient.ts` coexists with `net/room.ts`.
//
// The Convex session is drastically simpler than the Colyseus one — there is no
// seat, no seat-hold, and no reconnect token (D9): a returning client just
// re-subscribes. It holds only "the matchId I'm currently in" + the live Convex
// subscription handle (the `subscribeMatch` disposer). `leaveCurrent()` is the
// `leaveMatch` mutation + unsubscribe. Blocker-3's single-owner-connection concern
// dissolves: re-entering a match is idempotent and a fresh subscribe is cheap.

import {
  leaveMatch as convexLeaveMatch,
  subscribeMatch,
  type ConvexNetHandlers,
} from "../../net/convexClient.js";

class ConvexMatchSession {
  /** The matchId I'm currently subscribed to, or `null`. */
  private matchId: string | null = null;
  /** The live subscription disposer from `subscribeMatch`, or `null`. */
  private unsub: (() => void) | null = null;

  /** The id of the match I'm currently in, or `null` (Convex matchId string). */
  get currentMatchId(): string | null {
    return this.matchId;
  }

  /** True while a live subscription is held. */
  get isSubscribed(): boolean {
    return this.unsub !== null;
  }

  /**
   * Subscribe to a match's reactive doc (the Convex replacement for join/adopt).
   * IDEMPOTENT on the same matchId: re-subscribing to the match I'm already in
   * tears down the prior subscription and re-binds these handlers to the same
   * matchId (no seat, so this is cheap — it never opens a "second seat"). Switching
   * to a DIFFERENT matchId unsubscribes the previous one first (single owner).
   */
  subscribe(matchId: string, handlers: ConvexNetHandlers): void {
    if (this.unsub) this.unsub(); // tear down any prior subscription (same or other).
    this.matchId = matchId;
    this.unsub = subscribeMatch(matchId, handlers);
  }

  /**
   * Leave the current match and clear ownership: the `leaveMatch` mutation (records
   * abandon-loss + resolves forfeit for a live real match, plan 05) THEN unsubscribe.
   * Idempotent — safe with no current match. This is the Convex analog of the
   * Colyseus `leaveCurrent()` (`room.leave()`), the ONLY place a match is left.
   */
  async leaveCurrent(): Promise<void> {
    const id = this.matchId;
    this.unsub?.();
    this.unsub = null;
    this.matchId = null;
    if (id) await convexLeaveMatch(id);
  }

  /**
   * Drop the local subscription WITHOUT leaving the match (e.g. on scene SHUTDOWN /
   * nav within the match flow). Does NOT call `leaveMatch` — the match continues; a
   * later `subscribe` re-attaches. (The Convex analog of disposing scene listeners.)
   */
  unsubscribe(): void {
    this.unsub?.();
    this.unsub = null;
  }
}

/**
 * The single-owner Convex match session — matchId + the live `subscribeMatch`
 * handle; `leaveCurrent` = `leaveMatch` mutation + unsubscribe (no seat / no
 * reconnection token). Coexists with the Colyseus `matchSession` until plan 12.
 */
export const convexMatchSession = new ConvexMatchSession();
