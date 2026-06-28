/**
 * Native Convex+Clerk auth config (Phase 9, D-05/D-10; CONVEX-MIGRATION §4 D5 + §6).
 *
 * This is the WHOLE auth wiring for the Convex backend. It REPLACES the
 * hand-rolled `verifyClerk`/networkless-JWKS wrapper (packages/server/src/auth/
 * clerk.ts) and the token-in-join-options pitfall class (D-05/D-10): with this
 * config, `ctx.auth.getUserIdentity()` is populated natively from the Clerk JWT
 * the client attaches via `client.setAuth(() => clerk.session.getToken({
 * template: "convex" }))`. The value preserved is the Clerk `sub`, which becomes
 * `getUserIdentity().subject` — the same `accountId` `verifyClerk` returned
 * (clerk.ts:38). accountId is therefore ALWAYS the verified token subject, never
 * a client arg (T-09-01).
 *
 * REQUIRED external config (NOT committed — set at the Task-3 gate, R6):
 *   - Convex dashboard env var `CLERK_JWT_ISSUER_DOMAIN` = the Clerk Frontend
 *     API / issuer URL for the deployment.
 *   - A Clerk JWT template named EXACTLY `convex` (applicationID below must match
 *     the template's audience). If `getUserIdentity()` returns null, this
 *     template/issuer is misconfigured (Pitfall 1 / R6).
 *
 * A1 (to confirm empirically at the Task-3 gate): a newer Clerk→Convex
 * integration can pre-map the `aud` claim via `CLERK_FRONTEND_API_URL`, which may
 * make the manual `convex` JWT template unnecessary. Try without the manual
 * template first; if `getUserIdentity()` is null, create it.
 */
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};
