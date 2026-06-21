/**
 * Clerk token verification wrapper (AUTH-03 — "one token, two consumers").
 *
 * `verifyClerk(token)` is the SINGLE shared verify seam used by BOTH consumers:
 *   - the authoritative room's `onAuth` (wired in plan 04), and
 *   - the Meta-API Bearer-gated profile routes (wired here in plan 03).
 *
 * It wraps `@clerk/backend`'s `verifyToken` and maps Clerk's token payload
 * (`{ sub, sid, ... }`) to this app's identity shape `{ accountId, sessionId }`.
 * `sub` is the Clerk user id (the `auth_user_id` Convex persists) and `sid` is
 * the Clerk session id.
 *
 * VERIFY PATH (RESEARCH A4 — networkless):
 *   - `jwtKey` (CLERK_JWT_KEY, the PEM public key) enables the NETWORKLESS path —
 *     `verifyToken` verifies the JWT signature locally with no round-trip to
 *     Clerk, the hot-path default for `onAuth`.
 *   - `secretKey` (CLERK_SECRET_KEY) is the network fallback path.
 *   - `authorizedParties` (CLERK_AUTHORIZED_PARTIES, comma-separated origins)
 *     pins the allowed `azp` so a token minted for another origin is rejected.
 *
 * On a bad / expired / wrong-origin token, `verifyToken` REJECTS; we let that
 * rejection propagate so callers (`onAuth`, the profile routes) catch it and
 * deny (401 / refuse the WS join). We never swallow a verify failure.
 */
import { verifyToken } from "@clerk/backend";

export async function verifyClerk(
  token: string,
): Promise<{ accountId: string; sessionId: string }> {
  const payload = await verifyToken(token, {
    jwtKey: process.env.CLERK_JWT_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
    authorizedParties: (process.env.CLERK_AUTHORIZED_PARTIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  return { accountId: payload.sub, sessionId: payload.sid };
}
