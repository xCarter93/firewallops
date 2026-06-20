import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Phase-4 persistence skeleton (DEPLOY-04, Convex half).
 *
 * Auth-agnostic by design: `auth_user_id` is the external subject id (the auth
 * provider's `sub` in Phase 5). NOTHING auth-specific (no provider fields, no
 * email/token) is baked in now so Phase-5 auth wiring lands without a migration fight.
 *
 * Skeleton only — NO mutations / write logic this phase (CONTEXT "Database / persistence").
 * `_id` + `_creationTime` are auto-added by Convex; do not declare them.
 */
export default defineSchema({
  accounts: defineTable({
    auth_user_id: v.string(),
    display_name: v.optional(v.string()),
    wins: v.optional(v.number()),
    losses: v.optional(v.number()),
  }).index("by_auth_user_id", ["auth_user_id"]),
});
