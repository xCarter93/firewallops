/**
 * PLACEHOLDER MatchRoom (Plan 02 / Wave 1).
 *
 * Plan 03 OWNS and OVERWRITES this file — it adds the WAITING→TURN_START→
 * AIMING→RESOLVING→RESULTS state machine, the `messages = {}` Zod-validated
 * handlers, the active-player/phase authority gate, `this.clock`-scheduled turn
 * timers, the in-memory TerrainMask + carve-replay, and the `shotResult`
 * broadcast. This placeholder exists ONLY so `index.ts` compiles in Wave 1.
 *
 * Source for the 0.17 Room shape (object-generic `Room<{ state }>`,
 * `onAuth(client, options, context)`, `this.setState(...)`): 03-RESEARCH.md
 * "State of the Art" + "Code Examples → Stub seams" (Colyseus 0.17 migration
 * guide, verified 2026-06-19).
 */
import { Room, Client } from "@colyseus/core";
import { MatchState } from "./schema/MatchState.js";

export class MatchRoom extends Room<{ state: MatchState }> {
  onCreate(): void {
    this.setState(new MatchState());
    // Plan 03 replaces this body with the turn machine + message handlers.
  }

  /**
   * Stub identity handshake — returns a per-session guest accountId, which
   * becomes `client.auth.accountId`. Real Clerk `verifyToken` (reading
   * `context.token`) is Phase 5; the seam is wired, the trust decision is
   * deferred by design (§6.4 / CONTEXT).
   */
  async onAuth(
    client: Client,
    _options: unknown,
    _context: unknown,
  ): Promise<{ accountId: string }> {
    return { accountId: `guest-${client.sessionId}` };
  }
}
