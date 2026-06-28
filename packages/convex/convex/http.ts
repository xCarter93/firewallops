/**
 * Convex HTTP router — the Svix-verified Clerk provisioning webhook (Phase 9,
 * Plan 09-11, review [A1]). This is the Convex HTTP-action replacement for the
 * REST `POST /internal/webhooks/clerk` (server/src/meta/webhooks.ts +
 * routes.ts:127-137), ported BEFORE the plan-12 cutover deletes packages/server.
 *
 * SECURITY POSTURE (ported VERBATIM from the server webhook — threat
 * T-09-27 / T-05-AUTH-01, Spoofing):
 *   - The signature is verified with Svix's `Webhook.verify` over the RAW request
 *     body. In Convex an httpAction reads the raw bytes via `await request.text()`
 *     (the analog of the server's `express.raw` BEFORE any json parser, Pitfall 3
 *     — a re-serialized json body would fail HMAC). The exact bytes Clerk signed
 *     are what we verify.
 *   - A bad / replayed signature → `verify` throws → we return 400 and NEVER
 *     provision.
 *   - On a verified `user.created` event we provision idempotently via
 *     `api.accounts.provision` (idempotent by `auth_user_id`, so a Svix
 *     re-delivery — Svix retries on a non-2xx — is safe).
 *   - `CLERK_WEBHOOK_SECRET` is read from the Convex deployment env (set in the
 *     Convex dashboard — a FOUNDER action, NOT committed).
 *
 * FOUNDER DASHBOARD ACTIONS (NOT code — see the SUMMARY):
 *   - set `CLERK_WEBHOOK_SECRET` in the Convex dashboard env;
 *   - repoint the Clerk dashboard webhook endpoint to the Convex HTTP action URL
 *     (`https://<deployment>.convex.site/clerk-webhook`).
 */
import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

/**
 * The Clerk `user.created` provisioning webhook, as a Convex HTTP action.
 *
 * Reads the RAW body + the Svix headers, verifies the signature, and on a verified
 * `user.created` runs the idempotent `provision` mutation. Mirrors the server
 * `clerkWebhookHandler` exactly: 400 + no-provision on a bad/replayed signature.
 */
const clerkWebhook = httpAction(async (ctx, request) => {
  // RAW bytes Clerk signed (Pitfall 3 — never a re-serialized json body).
  const rawBody = await request.text();
  const svixId = request.headers.get("svix-id") ?? "";
  const svixTimestamp = request.headers.get("svix-timestamp") ?? "";
  const svixSignature = request.headers.get("svix-signature") ?? "";

  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET ?? "");

  let evt: { type?: string; data?: { id?: string } };
  try {
    evt = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as { type?: string; data?: { id?: string } };
  } catch {
    // Bad / replayed signature → reject, NEVER provision (T-09-27).
    return new Response("invalid signature", { status: 400 });
  }

  if (evt.type === "user.created" && evt.data?.id) {
    // Idempotent by auth_user_id, so a Svix re-delivery is safe.
    await ctx.runMutation(api.accounts.provision, { authUserId: evt.data.id });
  }
  return new Response(null, { status: 200 });
});

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: clerkWebhook,
});

export default http;
