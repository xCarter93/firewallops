/**
 * Svix-verified Clerk `user.created` provisioning webhook (AUTH-04).
 *
 * BARE, structurally-typed handler (like `matchResultsHandler`) so it is
 * unit-testable WITHOUT booting Express — the plan-02 scaffold imports it
 * dynamically and drives it with fake req/res.
 *
 * SECURITY (threat T-05-AUTH-01 — Spoofing):
 *   - The signature is verified with Svix's `Webhook.verify` over the RAW request
 *     body. The route MUST mount this with `express.raw({ type: "application/json" })`
 *     and BEFORE any json parser (routes.ts), so the exact bytes Clerk signed are
 *     what we verify (Pitfall 3 — a re-serialized json body would fail HMAC).
 *   - A bad / replayed signature → `verify` throws → we respond 400 and NEVER
 *     provision.
 *   - On a verified `user.created` event we provision idempotently (Convex
 *     `provision` is idempotent by `auth_user_id`, so a Svix re-delivery is safe).
 *
 * The `provision` callback is INJECTABLE (3rd arg) so the unit test passes a spy;
 * production wiring (routes.ts) passes the default Convex provision.
 */
import { Webhook } from "svix";
import { getConvex, api } from "./convexClient.js";

/** Minimal structural request: Svix headers + the RAW (string/Buffer) body. */
export interface ClerkWebhookRequest {
  headers: Record<string, unknown>;
  body: unknown;
}

/** Minimal structural response capturing the status code (mirrors the routes). */
export interface ClerkWebhookResponse {
  status: (code: number) => { end: () => void; json?: (b: unknown) => void; send?: (b?: unknown) => void };
}

/** Default production provision: fire the idempotent Convex `provision` mutation. */
function defaultProvision(userId: string): void {
  // Fire-and-forget: Svix retries on a non-2xx, and `provision` is idempotent by
  // auth_user_id, so a transient failure is recovered by re-delivery. We respond
  // 200 once verification + dispatch succeed.
  void getConvex().mutation(api.accounts.provision, { authUserId: userId });
}

/**
 * Verify the Svix signature over the raw body; on success, provision a
 * `user.created` event's user id. The handler is synchronous (matches the
 * scaffold contract): it dispatches provisioning and responds.
 */
export function clerkWebhookHandler(
  req: ClerkWebhookRequest,
  res: ClerkWebhookResponse,
  provision: (userId: string) => void = defaultProvision,
): void {
  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET ?? "");

  let evt: { type?: string; data?: { id?: string } };
  try {
    evt = wh.verify(req.body as string, {
      "svix-id": String(req.headers["svix-id"] ?? ""),
      "svix-timestamp": String(req.headers["svix-timestamp"] ?? ""),
      "svix-signature": String(req.headers["svix-signature"] ?? ""),
    }) as { type?: string; data?: { id?: string } };
  } catch {
    // Bad / replayed signature → reject, NEVER provision (T-05-AUTH-01).
    res.status(400).end();
    return;
  }

  if (evt.type === "user.created" && evt.data?.id) {
    provision(evt.data.id);
  }
  res.status(200).end();
}
