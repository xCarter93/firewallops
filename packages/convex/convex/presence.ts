/**
 * Disconnected-opponent presence cue (Phase 9, Plan 09; D-05 / review [R]).
 *
 * The in-Convex replacement for the Colyseus `MatchRoom` socket-drop signal
 * (`onDrop:501` `m.connected = false` / `onReconnect:527` `m.connected = true`,
 * the writes that drove `MechView.setConnected`). The official
 * `@convex-dev/presence` component (D-05, 09-RESEARCH §"Standard Stack") owns the
 * actual liveness detection: a ~5s client heartbeat keeps a session "present"; a
 * missed heartbeat (or an explicit `sendBeacon`-on-tab-close) flips it absent
 * after the component's offline window. We do NOT hand-roll a heartbeat table or
 * a reaper cron (09-RESEARCH §"Don't Hand-Roll").
 *
 * AUTHORITY MODEL (review [R] — the load-bearing finding):
 *   `mobiles[].connected` is patched SERVER-SIDE here, NOT merged client-side into
 *   `convexDocToSyncedState`. The room key is the `matchId`; the per-user key is
 *   the seat `mobileId`, which is resolved SERVER-SIDE from the verified subject
 *   (`getUserIdentity().subject` → the caller's own `mobiles[].accountId`). A
 *   client never asserts ANOTHER player's `connected` flag, and never even names
 *   its own mobileId — the server derives it. After every presence transition we
 *   re-derive `connected` for every seat from the component's own present-set and
 *   patch it onto the SAME `matches` doc every client already subscribes to, so
 *   all observers agree (parity with the old server-set `MatchState.ts:67`).
 *
 * SCOPE: presence is used STRICTLY for the disconnect/away cue. Live-aim is a
 * separate `matchAim` mechanism (plan 10); presence-for-aim was rejected in
 * 09-RESEARCH (D-01) — do NOT add aim to this component.
 *
 * THREAT NOTES (09-09 register):
 *   - T-09-18 (client spoofs connected): the flag is server-patched from the
 *     component's own signal; a client cannot assert another seat's flag, and even
 *     a self-spoof is cosmetic-only (the turn timer advances regardless, D-02/D9).
 *   - T-09-19 (heartbeat write flood): @convex-dev/presence throttles heartbeats
 *     (~5s); there are no per-frame writes here.
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { components } from "./_generated/api";
import { Presence } from "@convex-dev/presence";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * The presence component instance, bound to the registered `components.presence`
 * (convex.config.ts). All liveness state (heartbeat timestamps, offline timeout)
 * lives inside the component's own tables — never on our `matches` doc.
 */
export const presence = new Presence(components.presence);

// Server-owned bounds on the client-reported heartbeat cadence. The component
// derives the offline timeout as ~2.5x this interval, so an unbounded client value
// could keep a session "present" forever (or spam sub-second writes). The client
// uses 5000ms (convexClient.PRESENCE_HEARTBEAT_MS); this band tolerates jitter
// while capping the worst-case offline window.
const MIN_HEARTBEAT_MS = 1000;
const MAX_HEARTBEAT_MS = 15000;

/** Reject + return the verified Clerk subject (mirrors match.ts:requireIdentity). */
async function requireIdentity(ctx: MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("not authenticated");
  return identity.subject;
}

/**
 * [R] Re-derive `mobiles[].connected` for EVERY seat in a match from the presence
 * component's own present-set and patch the `matches` doc. This is the single
 * authoritative write path — both `heartbeat` (present) and `disconnect` (absent)
 * call it so the flag converges on the component's signal, not on any client
 * assertion. The room key is the `matchId`; presence user-ids are seat `mobileId`s.
 *
 * Only patches when at least one seat's `connected` actually changes (avoids
 * churning the reactive doc — and therefore every subscriber — on a no-op
 * heartbeat). A `mobileId` with no presence entry reads absent (connected:false);
 * the training dummy (no heartbeat) is excluded so it never dims (it has no
 * `accountId` and is server-owned/passive).
 */
async function reconcileConnected(
  ctx: MutationCtx,
  matchId: Id<"matches">,
): Promise<void> {
  const match = await ctx.db.get(matchId);
  if (!match) return;

  // The component's authoritative present-set for this room (online users only).
  // `listRoom(ctx, roomId, onlineOnly)` returns the per-user presence rows; the
  // `userId` field is our seat `mobileId`.
  const presentRows = await presence.listRoom(ctx, matchId, true);
  const onlineIds = new Set(presentRows.map((r) => r.userId));

  let changed = false;
  const nextMobiles = match.mobiles.map((m) => {
    // The training dummy is server-owned + passive and never heartbeats; leave its
    // `connected` untouched so it never reads AWAY.
    if (!m.accountId) return m;
    const connected = onlineIds.has(m.mobileId);
    if (connected === m.connected) return m;
    changed = true;
    return { ...m, connected };
  });

  if (changed) {
    await ctx.db.patch(matchId, { mobiles: nextMobiles });
  }
}

/**
 * Resolve the CALLER's own seat `mobileId` for a match SERVER-SIDE from the
 * verified subject (D-08) — never trust a client-sent id. Returns null when the
 * caller is not a member of the match (so a non-member's heartbeat is inert
 * rather than an error — a stale beacon after leaving must not throw).
 */
async function callerMobileId(
  ctx: MutationCtx,
  matchId: Id<"matches">,
  accountId: string,
): Promise<string | null> {
  const match = await ctx.db.get(matchId);
  if (!match) return null;
  const mine = match.mobiles.find((m) => m.accountId === accountId);
  return mine ? mine.mobileId : null;
}

/**
 * Client heartbeat (EMIT path). The client calls this on an interval for the
 * active match; the `@convex-dev/presence` component records the session present
 * keyed by `(matchId, mobileId)`, then [R] re-derives `connected` onto the
 * `matches` doc. Returns the `{ roomToken, sessionToken }` the client needs to
 * (a) keep heartbeating and (b) fire the tab-close disconnect beacon.
 *
 * Identity is server-derived: the room key is the `matchId` arg, but the per-user
 * key is the caller's OWN seat `mobileId` resolved from the verified subject — the
 * client never names a mobileId, so it cannot heartbeat as another player. A
 * non-member heartbeat is a no-op (returns empty tokens) rather than an error.
 */
export const heartbeat = mutation({
  args: {
    matchId: v.id("matches"),
    sessionId: v.string(),
    // Required: the client always sends its real heartbeat cadence
    // (PRESENCE_HEARTBEAT_MS) and the component derives the offline timeout as
    // 2.5x this value, so it must reflect the actual interval — not a default.
    interval: v.number(),
  },
  handler: async (ctx, { matchId, sessionId, interval }) => {
    const accountId = await requireIdentity(ctx);
    const mobileId = await callerMobileId(ctx, matchId, accountId);
    if (!mobileId) return { roomToken: "", sessionToken: "" };

    // Clamp the client-reported cadence into the server-owned band so a malicious
    // or buggy client cannot inflate the offline window (timeout ≈ 2.5x interval)
    // and appear present forever, nor spam sub-second heartbeats.
    const safeInterval = Math.min(
      Math.max(interval, MIN_HEARTBEAT_MS),
      MAX_HEARTBEAT_MS,
    );

    const tokens = await presence.heartbeat(
      ctx,
      matchId,
      mobileId,
      sessionId,
      safeInterval,
    );
    await reconcileConnected(ctx, matchId);
    return tokens;
  },
});

/**
 * Explicit disconnect (tab-close beacon path). The client fires this via
 * `navigator.sendBeacon` on `pagehide`/`visibilitychange:hidden` so the opponent
 * sees the AWAY cue immediately rather than waiting out the heartbeat-timeout
 * window. The component marks the session gone; [R] then re-derives `connected`.
 *
 * `sessionToken` comes from `heartbeat`'s return; it does not encode identity we
 * trust for the patch — the patch reads the component's present-set, so a forged
 * token at worst marks the caller's OWN session absent. We still require auth and
 * pass the `matchId` so the reconcile patches the right doc.
 */
export const disconnect = mutation({
  args: {
    matchId: v.id("matches"),
    sessionToken: v.string(),
  },
  handler: async (ctx, { matchId, sessionToken }) => {
    await requireIdentity(ctx);
    if (sessionToken) {
      await presence.disconnect(ctx, sessionToken);
    }
    await reconcileConnected(ctx, matchId);
  },
});
