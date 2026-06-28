/**
 * Account persistence mutations + queries (Phase 5 — AUTH-04 / AUTH-05).
 *
 * Convex is PERSISTENCE ONLY (per the Architectural Responsibility Map): the
 * Meta-API owns token verification + provisioning, the authoritative room owns
 * W/L authorship; these mutations are the durable seams those callers invoke via
 * `ConvexHttpClient.mutation(api.accounts.*)`.
 *
 * CROSS-PLAN CONTRACTS this module OWNS (plans 04 + 05 consume identically):
 *   - OUTCOME MODEL (Blocker 2): `recordResult` takes an EXPLICIT per-player
 *     `outcome` enum — NEVER a boolean win-flag. `win`→wins+1; `loss` AND
 *     `abandon_loss`→losses+1; `draw`→neither. The explicit enum kills the
 *     draw-as-false-win-flag→wrong-loss self-contradiction the review flagged.
 *   - GRANULAR IDEMPOTENCY (Blocker 2): each per-player write carries a UNIQUE
 *     `resultId` = `${roomId}:${event}:${accountId}` (event ∈ {final, abandon}).
 *     A `result_events` row records an applied id; a repeated id is a no-op, so a
 *     final-match write and an abandon write for the same room+player never
 *     collide (the old `resultId: roomId` collided).
 *   - DISPLAY NAME (Blocker 1): the public game handle = `accounts.display_name`,
 *     exposed via `getByAuthUserId` (read) + `setDisplayName` (write). Plan 04
 *     reads it server-side and syncs it as the PUBLIC `Mobile.displayName`; the
 *     Clerk `sub`/accountId stays server-side only and is NEVER a synced field.
 *
 * Every account read/write hits the existing `by_auth_user_id` index — no
 * full-table scan (Convex 32k-scan cap safe).
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Provision an account for a freshly-signed-up auth user (AUTH-04).
 *
 * Idempotent by `auth_user_id`: a webhook retry (Svix re-delivers) returns the
 * existing row instead of inserting a duplicate. Called by the Clerk
 * `user.created` webhook handler.
 */
export const provision = mutation({
  args: { authUserId: v.string() },
  handler: async (ctx, { authUserId }) => {
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_auth_user_id", (q) => q.eq("auth_user_id", authUserId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("accounts", {
      auth_user_id: authUserId,
      wins: 0,
      losses: 0,
    });
  },
});

/**
 * Set the public game handle (`display_name`) for the first-login handle prompt
 * (AUTH-04, Blocker 1). Handles the handle-prompt-BEFORE-webhook race: if the
 * account row does not exist yet, insert it (with the name) rather than failing.
 */
export const setDisplayName = mutation({
  args: { authUserId: v.string(), displayName: v.string() },
  handler: async (ctx, { authUserId, displayName }) => {
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_auth_user_id", (q) => q.eq("auth_user_id", authUserId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { display_name: displayName });
      return existing._id;
    }
    return await ctx.db.insert("accounts", {
      auth_user_id: authUserId,
      display_name: displayName,
      wins: 0,
      losses: 0,
    });
  },
});

/**
 * Record an EXPLICIT per-player match outcome (AUTH-05, Blocker 2).
 *
 * NO boolean win-flag. Granular per-player+event idempotency via `result_events`:
 *   1. dedup — if `resultId` already applied, return early (safe no-op for a
 *      retry OR a final/abandon overlap on the same room+player).
 *   2. record the applied id, then find/insert the account by index.
 *   3. apply the outcome: `win`→wins+1; `loss` OR `abandon_loss`→losses+1;
 *      `draw`→patch NOTHING (counts as neither).
 */
export const recordResult = mutation({
  args: {
    authUserId: v.string(),
    outcome: v.union(
      v.literal("win"),
      v.literal("loss"),
      v.literal("draw"),
      v.literal("abandon_loss"),
    ),
    resultId: v.string(),
  },
  handler: async (ctx, { authUserId, outcome, resultId }) => {
    // 1. Granular per-player+event dedup.
    const already = await ctx.db
      .query("result_events")
      .withIndex("by_result_id", (q) => q.eq("result_id", resultId))
      .unique();
    if (already) return; // already applied — no-op.
    await ctx.db.insert("result_events", { result_id: resultId });

    // 2. Find/insert the account by index (no full-table scan).
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_auth_user_id", (q) => q.eq("auth_user_id", authUserId))
      .unique();
    const acc =
      existing ??
      (await ctx.db.get(
        await ctx.db.insert("accounts", {
          auth_user_id: authUserId,
          wins: 0,
          losses: 0,
        }),
      ))!;

    // 3. Apply the explicit outcome. draw → neither.
    if (outcome === "win") {
      await ctx.db.patch(acc._id, { wins: (acc.wins ?? 0) + 1 });
    } else if (outcome === "loss" || outcome === "abandon_loss") {
      await ctx.db.patch(acc._id, { losses: (acc.losses ?? 0) + 1 });
    }
  },
});

/**
 * Read an account by auth user id for the profile read (display_name + wins +
 * losses), via the `by_auth_user_id` index. Returns the row or null.
 */
export const getByAuthUserId = query({
  args: { authUserId: v.string() },
  handler: async (ctx, { authUserId }) => {
    return await ctx.db
      .query("accounts")
      .withIndex("by_auth_user_id", (q) => q.eq("auth_user_id", authUserId))
      .unique();
  },
});

/**
 * The hard length bound on a display handle (`accounts.display_name`). Mirrors the
 * client handle-modal `maxLength = 24` (overlays.ts) so the server is the final
 * authority on the bound the UI advertises. A handle longer than this is rejected
 * (the REST `POST /internal/profile` 400-on-bad-input parity — review [A1]).
 */
const MAX_DISPLAY_NAME_LEN = 24;

// ── AUTHED PROFILE WRAPPERS (Plan 09-11, review [A1]) ────────────────────────
// These are the Convex replacements for the REST `GET`/`POST /internal/profile`
// (server/src/meta/routes.ts). The REST routes derived the accountId from the
// verified Bearer `sub` (NEVER the body); these mirror that EXACTLY by deriving
// `accountId = getUserIdentity().subject` and accepting NO id from args (D-08).
// They reuse the existing index-backed `getByAuthUserId`/`setDisplayName` paths;
// the underlying functions are unchanged.

/** Reject when unauthenticated + return the verified Clerk subject (D-08/D-10). */
async function requireSubject(ctx: {
  auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
}): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");
  return identity.subject;
}

/**
 * Authed profile READ (replaces `GET /internal/profile`). The accountId is the
 * caller's verified identity subject — the client NEVER supplies an id (D-08), so
 * a caller can only ever read their OWN row (T-09-28). Returns the `accounts` row
 * (display_name + wins + losses) for that subject, or `null` when no row exists
 * yet (drives the first-login handle prompt). Rejects unauthenticated callers (no
 * leak). Reuses the same `by_auth_user_id` index `getByAuthUserId` uses.
 */
export const getMyProfile = query({
  args: {},
  handler: async (ctx) => {
    const accountId = await requireSubject(ctx);
    return await ctx.db
      .query("accounts")
      .withIndex("by_auth_user_id", (q) => q.eq("auth_user_id", accountId))
      .unique();
  },
});

/**
 * Authed display-name WRITE (replaces `POST /internal/profile`). Mirrors the REST
 * write's invariants:
 *   - the accountId is the verified identity subject — NEVER read from args (D-08,
 *     T-09-26): a caller cannot write another player's handle, and any client-sent
 *     id is structurally impossible (the only arg is `displayName`).
 *   - validates a non-empty handle within `MAX_DISPLAY_NAME_LEN` (the REST 400-on-
 *     empty parity, extended with the upper bound the UI advertises).
 *   - persists via the existing `setDisplayName` path (insert-or-patch by index),
 *     which also handles the handle-prompt-BEFORE-webhook race.
 * Rejects unauthenticated callers.
 */
export const setMyDisplayName = mutation({
  args: { displayName: v.string() },
  handler: async (ctx, { displayName }) => {
    const accountId = await requireSubject(ctx);
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      throw new Error("display name must not be empty");
    }
    if (trimmed.length > MAX_DISPLAY_NAME_LEN) {
      throw new Error(
        `display name must be at most ${MAX_DISPLAY_NAME_LEN} characters`,
      );
    }
    // Reuse the existing insert-or-patch-by-index write for the verified subject.
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_auth_user_id", (q) => q.eq("auth_user_id", accountId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { display_name: trimmed });
      return existing._id;
    }
    return await ctx.db.insert("accounts", {
      auth_user_id: accountId,
      display_name: trimmed,
      wins: 0,
      losses: 0,
    });
  },
});
