/**
 * convexMatchSession — THE SINGLE-OWNER match subscription manager.
 *
 * This module-singleton owns AT MOST ONE live Convex match subscription at a time
 * and is the only seam any page uses to subscribe / leave a match. ONE subscription
 * survives the `/room/:id → /play/:id` transition: the room page subscribes, the
 * play page reads `currentMatchId` and the scene re-subscribes against the SAME
 * matchId WITHOUT leaving on the transition (re-subscribing is idempotent + cheap —
 * there is no seat, no seat-hold, no reconnection token; D9).
 *
 * `leaveCurrent()` (the `leaveMatch` mutation + unsubscribe) is the ONLY place a
 * match is left — only navigating AWAY from the match flow (RETURN TO LOBBY / a real
 * quit) calls it; the room→play transition never does. `unsubscribe()` drops the
 * local feed WITHOUT leaving (scene SHUTDOWN / nav within the flow).
 */

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
   * Subscribe to a match's reactive doc. IDEMPOTENT on the same matchId:
   * re-subscribing to the match I'm already in tears down the prior subscription and
   * re-binds these handlers to the same matchId (no seat, so this is cheap — it never
   * opens a "second seat"). Switching to a DIFFERENT matchId unsubscribes the
   * previous one first (single owner).
   */
  subscribe(matchId: string, handlers: ConvexNetHandlers): void {
    if (this.unsub) this.unsub(); // tear down any prior subscription (same or other).
    this.matchId = matchId;
    this.unsub = subscribeMatch(matchId, handlers);
  }

  /**
   * Leave the current match and clear ownership: the `leaveMatch` mutation (records
   * abandon-loss + resolves forfeit for a live real match, plan 05) THEN unsubscribe.
   * Idempotent — safe with no current match. The ONLY place a match is left.
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
   * later `subscribe` re-attaches.
   */
  unsubscribe(): void {
    this.unsub?.();
    this.unsub = null;
  }
}

/**
 * The single-owner Convex match session — matchId + the live `subscribeMatch`
 * handle; `leaveCurrent` = `leaveMatch` mutation + unsubscribe (no seat / no
 * reconnection token).
 */
export const convexMatchSession = new ConvexMatchSession();
